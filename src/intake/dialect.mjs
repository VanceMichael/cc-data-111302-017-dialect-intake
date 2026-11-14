// 方言候选探测：在有界样本上枚举“编码 × 分隔符 × 引号 × 金额格式”候选，
// 每个候选都给出成立依据或拒绝理由。判定不只看列数稳定，还结合表头、
// 必填字段与金额类型。业务结果不同的候选生成不同指纹，交人工确认。

import { parseCsvText } from './csv.mjs';
import { detectHeader, validateRow, headerLikeness } from './schema.mjs';
import { resolveMoneyFormat } from './money.mjs';

export const DELIMITERS = [',', ';', '\t', '|'];
const QUOTES = ['"', "'"];
const MAX_SAMPLE_BYTES = 64 * 1024;
// 行数上限刻意小于“整批”：抽样只负责形成候选，晚到反例（如 late 素材第 31 行）
// 必须留给全量复核拦截，这正是“前面猜测直接入库”事故的防线。
export const MAX_SAMPLE_LINES = 30;

// 读取有界样本：按字节上限与“完整行数”上限截断，绝不整文件读入。
// 截断点对齐换行符边界，保证第 maxLines+1 行不进入样本——晚到反例必须留给全量复核。
export async function readSample(byteChunks, { maxBytes = MAX_SAMPLE_BYTES, maxLines = MAX_SAMPLE_LINES } = {}) {
  const chunks = [];
  let bytes = 0;
  let lineEndings = 0;
  let truncated = false;
  let limitedBy = null;
  outer: for await (const chunk of byteChunks) {
    let cut = chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        lineEndings++;
        if (lineEndings >= maxLines) {
          cut = i + 1; // 包含该换行符，下一行被排除
          truncated = true;
          limitedBy = 'lines';
          break;
        }
      }
      if (bytes + i + 1 >= maxBytes) {
        cut = i + 1;
        truncated = true;
        limitedBy = 'bytes';
        break;
      }
    }
    const part = chunk.subarray(0, cut);
    chunks.push(part);
    bytes += part.length;
    if (truncated) break outer;
  }
  return { bytes: Buffer.concat(chunks), truncated, lines: lineEndings, limitedBy };
}

// 对单个 (分隔符, 引号) 结构候选做样本解释。
async function evaluateStructuralCandidate({ delimiter, quote, sampleText, encoding, bomLength, schema }) {
  const evidence = [];
  const rejectReasons = [];
  let rows;
  try {
    rows = await parseCsvText(sampleText, { delimiter, quote, encoding, bomLength });
  } catch (error) {
    return { conforms: false, rejectReasons: [`解析失败：${error.message}`], evidence: [] };
  }
  if (rows.length === 0) return { conforms: false, rejectReasons: ['样本中没有任何数据行'], evidence: [] };
  evidence.push(`样本解析出 ${rows.length} 行`);

  const widths = new Set(rows.map((row) => row.fields.length));
  if (widths.size !== 1) {
    rejectReasons.push(`列数不稳定，样本中出现列宽集合 [${[...widths].join(', ')}]`);
  } else {
    evidence.push(`样本 ${rows.length} 行列数一致（${[...widths][0]} 列）——注意列数稳定仅为必要条件而非通过依据`);
  }

  const alignedHeader = detectHeader(rows[0].fields, schema);
  evidence.push(...alignedHeader.evidence);
  // 对齐表头未命中时，用表头画像判断首行是不是被错位切分的标题行；
  // 若是，则跳过首行但保留“错位”证据，不让标题行污染类型校验。
  let header = alignedHeader;
  if (!alignedHeader.hasHeader) {
    const likeness = headerLikeness(rows[0].fields, schema);
    if (likeness.score >= 2) {
      header = { hasHeader: true, hits: [], misaligned: true, evidence: [`首行画像判定为表头（评分 ${likeness.score}：${likeness.signals.join('；')}），但与当前切分不对齐，跳过首行并记录错位`] };
      evidence.push(...header.evidence);
    }
  }
  const dataRows = header.hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) {
    return { conforms: false, rejectReasons: ['识别为表头后没有剩余数据行可供类型校验'], evidence, header };
  }

  const width = widths.values().next().value;
  if (width < schema.fields.length) {
    rejectReasons.push(`列宽 ${width} 少于契约必填字段数 ${schema.fields.length}`);
  }

  // 金额格只在 decimal 列上裁决，逐格保留解释依据。
  const decimalIndex = schema.fields.findIndex((f) => f.type === 'decimal');
  const moneyCells = decimalIndex >= 0 ? dataRows.map((row) => row.fields[decimalIndex] ?? '') : [];
  const money = resolveMoneyFormat(moneyCells);
  if (!money.formatId) {
    rejectReasons.push(...money.tried.filter((t) => !t.ok).map((t) => `金额格式 ${t.formatId} 有 ${t.failedCount} 格无法解释`));
  } else {
    evidence.push(...money.evidence);
  }

  // 逐行类型校验（即使结构候选最终被拒，也保留问题样本作为证据）。
  const rowChecks = dataRows.map((row, i) =>
    validateRow(row.fields, schema, money.formatId ?? 'inferred', { rowIndex: i, physicalLine: row.physicalLine }),
  );
  const badRows = rowChecks.filter((check) => !check.ok);
  if (badRows.length > 0) {
    rejectReasons.push(`样本中有 ${badRows.length}/${dataRows.length} 行未通过字段契约，例如：${badRows[0].problems.join('；')}`);
  } else {
    evidence.push(`样本 ${dataRows.length} 个数据行全部通过字段契约（含 decimal 类型解释）`);
  }

  const fingerprint = buildFingerprint({ delimiter, moneyFormat: money.formatId, header: header.hasHeader, rowChecks });
  return {
    conforms: rejectReasons.length === 0,
    rejectReasons,
    evidence,
    dialect: {
      encoding,
      bomLength,
      delimiter,
      quote,
      moneyFormat: money.formatId,
      hasHeader: header.hasHeader,
      headerMisaligned: header.misaligned === true,
      newline: inferNewline(sampleText),
    },
    header,
    money,
    fingerprint,
    sampleRowCount: dataRows.length,
    sampleChecks: rowChecks.slice(0, 10),
    weak: money.weak,
  };
}

function inferNewline(text) {
  if (text.includes('\r\n')) return 'CRLF';
  if (text.includes('\n')) return 'LF';
  if (text.includes('\r')) return 'CR';
  return '未知';
}

// 指纹：决定两个候选在业务上是否等价。列切分不同或金额规范值不同 → 指纹不同。
// 引号字符不进入指纹：双引号/单引号若产出完全相同的切格与规范值，就是同一业务解释。
function buildFingerprint({ delimiter, moneyFormat, header, rowChecks }) {
  const payload = {
    delimiter,
    moneyFormat,
    header,
    rows: rowChecks.map((check) => ({
      values: check.interpreted.map((cell) => cell.value),
      extra: check.extra,
    })),
  };
  return JSON.stringify(payload);
}

// 主入口：枚举候选、去重（相同指纹视为同一解释）、给出自动/人工裁决建议。
export async function probeCandidates({ sampleText, encoding, bomLength, schema }) {
  const raw = [];
  for (const delimiter of DELIMITERS) {
    for (const quote of QUOTES) {
      raw.push(await evaluateStructuralCandidate({ delimiter, quote, sampleText, encoding, bomLength, schema }));
    }
  }
  const conforming = [];
  const seen = new Map();
  for (const candidate of raw.filter((c) => c.conforms)) {
    const prior = seen.get(candidate.fingerprint);
    if (!prior) {
      seen.set(candidate.fingerprint, candidate);
      conforming.push(candidate);
      continue;
    }
    // 同业务指纹的引号变体：RFC4180 双引号优先于单引号
    if (prior.dialect.quote !== '"' && candidate.dialect.quote === '"') {
      const index = conforming.indexOf(prior);
      conforming[index] = candidate;
      seen.set(candidate.fingerprint, candidate);
    }
  }
  const rejectedDetails = raw
    .filter((c) => !c.conforms)
    .map((c) => ({ delimiter: c.dialect?.delimiter ?? '?', quote: c.dialect?.quote ?? '?', reasons: c.rejectReasons, evidence: c.evidence }));

  let decision;
  if (conforming.length === 0) {
    decision = { kind: 'reject', reason: '所有结构候选都无法在样本上成立，需要人工提供新方言或退回渠道' };
  } else if (conforming.length === 1) {
    decision = { kind: 'auto', reason: '仅有一个通过全部契约校验的候选，可自动选择（全量复核仍会执行）' };
  } else {
    decision = {
      kind: 'manual',
      reason: `存在 ${conforming.length} 个业务结果不同但同样合法的候选，列数稳定不能作为自动通过依据，转人工确认`,
    };
  }
  return { conforming, rejected: rejectedDetails, decision, sampleInfo: { bytes: Buffer.byteLength(sampleText), encoding } };
}

export function describeDialect(dialect) {
  const delimiterName = { ',': '逗号', ';': '分号', '\t': '制表符', '|': '竖线' }[dialect.delimiter] ?? dialect.delimiter;
  return `${dialect.encoding.toUpperCase()} / ${delimiterName}分隔 / ${dialect.quote === '"' ? '双引号' : '单引号'} / ${dialect.moneyFormat} / ${dialect.newline}换行${dialect.hasHeader ? ' / 含表头' : ' / 无表头'}`;
}
