// 接收编排：把“原始字节 → 候选证据 → 自动/人工裁决 → 全量复核 → 规范记录与版本”
// 串成可负责的流程。关键承诺：
// 1) 抽样只用于形成候选，入库前必须全量复核；
// 2) 后续行推翻已确认方言时暂停整批，前半批只留临时规范记录，绝不冒充完整交付；
// 3) 人工确认绑定内容哈希+解释指纹，同名异文件无法复用；
// 4) 发布物只追加新版本，历史不静默改写。

import { Readable } from 'node:stream';
import { sniffEncoding, decodeChunks } from './encoding.mjs';
import { streamCsv } from './csv.mjs';
import { readSample, probeCandidates } from './dialect.mjs';
import { validateRow, detectHeader } from './schema.mjs';
import { newRunId } from './store.mjs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

const SAMPLE_PREFIX_BYTES = 64 * 1024;

function asyncChunks(buffer) {
  return Readable.from((function* () { yield buffer; })());
}

// 把字节流包成可重复读取的两路：一路存原始字节，一路用于抽样。
async function teeAndStore(store, byteChunks, name) {
  const hash = createHash('sha256');
  const parts = []; // 仅抽样前缀驻留内存，其余直接落盘
  let prefixBytes = 0;
  let totalBytes = 0;
  const stored = await store.saveRaw(
    (async function* () {
      for await (const chunk of byteChunks) {
        totalBytes += chunk.length;
        hash.update(chunk);
        if (prefixBytes < SAMPLE_PREFIX_BYTES) {
          const take = Math.min(chunk.length, SAMPLE_PREFIX_BYTES - prefixBytes);
          parts.push(chunk.subarray(0, take));
          prefixBytes += take;
        }
        yield chunk;
      }
    })(),
    { name },
  );
  return { stored, samplePrefix: Buffer.concat(parts), totalBytes };
}

// 主入口：接收一份文件，返回处于 awaiting_confirmation / accepted / blocked / rejected 的运行记录。
export async function receiveFile({ store, name, byteChunks, schema, operator = 'system' }) {
  const runId = newRunId(name);
  const events = [];
  const log = (event, detail) => events.push({ at: new Date().toISOString(), event, detail });

  const { stored, samplePrefix, totalBytes } = await teeAndStore(store, byteChunks, name);
  log('raw-stored', { sha256: stored.sha256, size: totalBytes, name });

  const run = {
    runId,
    name,
    sha256: stored.sha256,
    size: totalBytes,
    status: 'probing',
    schema,
    schemaSummary: { fields: schema.fields.map((f) => f.name), extraColumns: schema.extraColumns },
    encoding: null,
    candidates: [],
    rejectedCandidates: [],
    decision: null,
    selected: null,
    attempts: [],
    events,
    missingEvidence: [],
    createdAt: new Date().toISOString(),
  };

  // 1) 编码判定（BOM/严格 UTF-8/Latin-1 回退），依据入档。
  const encodingDecision = sniffEncoding(samplePrefix);
  run.encoding = encodingDecision;
  log('encoding-decided', encodingDecision);

  // 2) 有界抽样，形成结构与金额候选。
  const sample = await readSample(asyncChunks(samplePrefix));
  let sampleText = '';
  const sampleDecoder = decodeChunks(asyncChunks(sample.bytes), encodingDecision.encoding, {
    bomLength: encodingDecision.bomLength,
  });
  for await (const text of sampleDecoder) sampleText += text;

  const probe = await probeCandidates({
    sampleText,
    encoding: encodingDecision.encoding,
    bomLength: encodingDecision.bomLength,
    schema,
  });
  run.decision = probe.decision;
  run.candidates = probe.conforming.map(stripHeavy);
  run.rejectedCandidates = probe.rejected;
  run.sample = { bytes: sample.bytes.length, lines: sample.lines, truncated: sample.truncated, limitedBy: sample.limitedBy };
  log('candidates-probed', { conforming: probe.conforming.length, decision: probe.decision.kind });

  if (probe.decision.kind === 'reject') {
    run.status = 'rejected';
    run.missingEvidence = ['没有任何候选能在样本上满足字段契约，需要渠道补充表头或方言说明'];
    log('run-rejected', probe.decision);
    await store.saveRun(run);
    return run;
  }

  // 3) 自动候选仍需检查是否已有同内容同指纹确认；人工候选先挂起。
  if (probe.decision.kind === 'manual') {
    run.status = 'awaiting_confirmation';
    run.missingEvidence = probe.conforming.flatMap((c) =>
      c.weak ? [`候选 ${c.dialect.delimiter} 含弱证据金额解释，需要人工确认采用哪种小数习惯`] : [],
    );
    if (run.missingEvidence.length === 0) {
      run.missingEvidence = ['多个候选在样本上同样合法且业务结果不同，需要人工选择采用哪一种方言'];
    }
    log('awaiting-confirmation', { candidates: probe.conforming.map((c) => c.fingerprint.slice(0, 24)) });
    await store.saveRun(run);
    return run;
  }

  const chosen = probe.conforming[0];
  // 自动路径同样尊重历史确认：若该内容曾被人工确认过别的指纹，不能静默改走自动候选。
  const prior = await findAnyPriorConfirmation(store, stored.sha256);
  if (prior) {
    run.status = 'awaiting_confirmation';
    run.missingEvidence = [`内容 ${stored.sha256.slice(0, 12)} 已有历史确认（指纹 ${prior.key}），自动候选不得覆盖，请人工裁决`];
    log('prior-confirmation-blocks-auto', { key: prior.key });
    await store.saveRun(run);
    return run;
  }
  return finalizeSelection({ store, run, candidate: chosen, schema, operator, source: 'auto' });
}

function stripHeavy(candidate) {
  return {
    dialect: candidate.dialect,
    fingerprint: candidate.fingerprint,
    evidence: candidate.evidence,
    weak: candidate.weak,
    sampleRowCount: candidate.sampleRowCount,
    sampleChecks: candidate.sampleChecks,
  };
}

async function findAnyPriorConfirmation(store, sha256) {
  const all = await store.listConfirmations();
  return all.find((record) => record.sha256 === sha256) || null;
}

// 全量复核：流式解析整份文件，逐行契约校验，规范记录逐行落盘（内存有界）。
export async function fullValidation({ store, run, dialect, schema, attempt, operator }) {
  const byteStream = store.streamRaw(run.sha256);
  const textStream = decodeChunks(byteStream, dialect.encoding, { bomLength: dialect.bomLength });

  // 给文本块补上字节起点，供解析器维护字节偏移。
  const byteEncoding = dialect.encoding === 'latin1' ? 'latin1' : dialect.encoding.startsWith('utf-16') ? 'utf16le' : 'utf8';
  let cursor = dialect.bomLength || 0;
  const totalBytes = run.size;
  const positioned = (async function* () {
    for await (const text of textStream) {
      const startByte = cursor;
      cursor += Buffer.byteLength(text, byteEncoding);
      yield { text, startByte };
    }
  })();

  const sink = store.createCanonicalSink(run.sha256, attempt);
  let rowCount = 0;
  let acceptedCount = 0;
  try {
    const rows = streamCsv(positioned, dialect);
    let headerSkipped = false;
    for await (const row of rows) {
      rowCount++;
      if (!headerSkipped && dialect.hasHeader) {
        if (dialect.headerMisaligned) {
          // 探测阶段已用表头画像确认首行是错位标题行，复核保持同一判定，直接跳过
          headerSkipped = true;
          continue;
        }
        const header = detectHeader(row.fields, schema);
        if (header.hasHeader) {
          headerSkipped = true;
          continue;
        }
      }
      const check = validateRow(row.fields, schema, dialect.moneyFormat, {
        rowIndex: row.index,
        physicalLine: row.physicalLine,
      });
      if (!check.ok) {
        sink.end();
        return {
          ok: false,
          conflict: {
            rowIndex: row.index,
            physicalLine: row.physicalLine,
            startByte: row.startByte,
            endByte: row.endByte,
            problems: check.problems,
            rawFields: row.fields,
          },
          rowCount,
          acceptedCount,
          canonicalRef: { sha256: run.sha256, attempt },
        };
      }
      sink.write(JSON.stringify({ rowIndex: row.index, physicalLine: row.physicalLine, bytes: [row.startByte, row.endByte], interpreted: check.interpreted, extra: check.extra }) + '\n');
      // 尊重写入背压，防止规范记录在内存积压
      if (sink.writableNeedDrain) {
        await once(sink, 'drain');
      }
      acceptedCount++;
    }
    sink.end();
    await once(sink, 'finish');
    return {
      ok: true,
      rowCount,
      acceptedCount,
      canonicalRef: { sha256: run.sha256, attempt, path: store.canonicalPath(run.sha256, attempt) },
    };
  } catch (error) {
    sink.end();
    return {
      ok: false,
      conflict: {
        physicalLine: error.physicalLine ?? null,
        startByte: error.byteOffset ?? null,
        endByte: totalBytes, // EOF 类错误（如未闭合引号）范围延伸到文件末尾
        problems: [error.message],
        code: error.code || 'PARSE_ERROR',
      },
      rowCount,
      acceptedCount,
      canonicalRef: { sha256: run.sha256, attempt },
    };
  }
}

// 选定候选后的统一收口：全量复核 → 冲突暂停 / 接受发布。
async function finalizeSelection({ store, run, candidate, schema, operator, source, confirmationRef }) {
  const attempt = run.attempts.length + 1;
  run.selected = { dialect: candidate.dialect, fingerprint: candidate.fingerprint, source, confirmationRef: confirmationRef || null, at: new Date().toISOString() };
  run.status = 'validating';
  run.events.push({ at: new Date().toISOString(), event: 'candidate-selected', detail: { source, attempt, dialect: candidate.dialect } });
  await store.saveRun(run);

  const result = await fullValidation({ store, run, dialect: candidate.dialect, schema, attempt, operator });
  run.attempts.push({
    attempt,
    source,
    operator,
    dialect: candidate.dialect,
    fingerprint: candidate.fingerprint,
    confirmationRef: confirmationRef || null,
    result,
    at: new Date().toISOString(),
  });

  if (!result.ok) {
    // 暂停整批：保留冲突范围与已解释前缀，前半批标记 provisional，不作为交付。
    run.status = 'blocked';
    run.conflict = result.conflict;
    run.events.push({ at: new Date().toISOString(), event: 'batch-paused', detail: result.conflict });
    await store.saveRun(run);
    return run;
  }

  run.status = 'accepted';
  run.events.push({ at: new Date().toISOString(), event: 'batch-accepted', detail: { rows: result.acceptedCount, attempt } });
  await store.saveRun(run);

  const publication = await store.publish({
    name: run.name,
    sha256: run.sha256,
    runId: run.runId,
    attempt,
    canonicalRef: result.canonicalRef,
    dialect: candidate.dialect,
    fingerprint: candidate.fingerprint,
    operator: source === 'auto' ? 'system-auto' : operator,
  });
  run.publication = { versionId: publication.versionId, version: publication.version, supersedes: publication.supersedes };
  run.events.push({ at: new Date().toISOString(), event: 'published', detail: run.publication });
  await store.saveRun(run);
  return run;
}

// 人工确认：校验确认对象确实是本次运行的合法候选，且绑定当前内容哈希。
export async function confirmCandidate({ store, runId, fingerprint, operator = 'staff', reason }) {
  const run = await store.loadRun(runId);
  const candidate = run.candidates.find((c) => c.fingerprint === fingerprint);
  if (!candidate) {
    throw new Error('确认的解释指纹不在本次运行的候选集合中，拒绝确认');
  }
  const confirmation = await store.saveConfirmation({
    runId,
    name: run.name,
    sha256: run.sha256,
    fingerprint,
    dialect: candidate.dialect,
    operator,
    reason: reason || '人工确认采用该方言',
  });
  run.events.push({ at: new Date().toISOString(), event: 'confirmation-recorded', detail: { key: confirmation.key, operator } });
  await store.saveRun(run);

  return finalizeSelection({ store, run, candidate, schema: run.schema, operator, source: 'manual', confirmationRef: confirmation.key });
}

// 支持人员修正选择后对同一原始字节重新解释：新尝试、新规范文件、新版本，旧记录保留。
export async function reinterpretWith({ store, runId, dialectChoice, operator = 'staff', reason }) {
  const run = await store.loadRun(runId);
  const candidate =
    (dialectChoice.fingerprint && run.candidates.find((c) => c.fingerprint === dialectChoice.fingerprint)) ||
    (dialectChoice.delimiter && run.candidates.find((c) => c.dialect.delimiter === dialectChoice.delimiter));
  if (!candidate) throw new Error('修正目标不在候选集合内；如需新方言须重新发起接收');
  const confirmation = await store.saveConfirmation({
    runId,
    name: run.name,
    sha256: run.sha256,
    fingerprint: candidate.fingerprint,
    dialect: candidate.dialect,
    operator,
    reason: reason || '人工修正方言选择后重新解释',
    supersedesAttempt: run.attempts.map((a) => a.attempt),
  });
  run.events.push({ at: new Date().toISOString(), event: 'reinterpret-requested', detail: { key: confirmation.key, operator } });
  await store.saveRun(run);
  return finalizeSelection({ store, run, candidate, schema: run.schema, operator, source: 'manual-reinterpret', confirmationRef: confirmation.key });
}
