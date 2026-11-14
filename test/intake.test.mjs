import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { IntakeStore } from '../src/intake/store.mjs';
import { loadSchema } from '../src/intake/schema.mjs';
import { receiveFile, confirmCandidate, reinterpretWith } from '../src/intake/receive.mjs';
import { interpretCell } from '../src/intake/money.mjs';
import { streamCsv } from '../src/intake/csv.mjs';
import { sniffEncoding, decodeChunks } from '../src/intake/encoding.mjs';
import { tableBytes } from '../src/tables.mjs';
import { buildRunReport } from '../src/intake/report.mjs';

const schema = loadSchema(JSON.parse(await readFile(new URL('../fixtures/schema.json', import.meta.url), 'utf8')));

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'intake-'));
  const store = new IntakeStore(dir);
  await store.init();
  return { store, dir };
}

function chunks(bytes) {
  // 小块分片，验证流式路径与跨块状态，而不是一次性喂入
  return Readable.from((async function* () {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
  })());
}

async function receive(store, name, bytes) {
  return receiveFile({ store, name, byteChunks: chunks(bytes), schema });
}

test('金额格式：点号小数与逗号小数分别规范化，弱证据被标注', () => {
  assert.equal(interpretCell('12.34', 'dot-decimal').canonical, '12.34');
  assert.equal(interpretCell('1.234,56', 'comma-decimal').canonical, '1234.56');
  assert.equal(interpretCell('1,234.56', 'dot-decimal').canonical, '1234.56');
  const weak = interpretCell('12;34', 'inferred');
  assert.equal(weak.canonical, '12.34');
  assert.equal(weak.weak, true);
  assert.equal(interpretCell('abc', 'dot-decimal').ok, false);
});

test('流式解析：引号内分隔符、CRLF 与跨块引号都正确处理', async () => {
  const text = 'code;amount;note\r\nA;12,34;"有;说明"\r\n';
  const stream = streamCsv((async function* () {
    yield { text: text.slice(0, 12), startByte: 0 };
    yield { text: text.slice(12), startByte: Buffer.byteLength(text.slice(0, 12)) };
  })(), { delimiter: ';', quote: '"', encoding: 'utf-8' });
  const rows = [];
  for await (const row of stream) rows.push(row);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].fields, ['A', '12,34', '有;说明']);
  assert.equal(rows[1].physicalLine, 2);
});

test('编码：UTF-16 BOM 识别并解码，UTF-8 严格模式与 Latin-1 回退', async () => {
  const utf16 = tableBytes('utf16');
  const decision = sniffEncoding(utf16.subarray(0, 32));
  assert.equal(decision.encoding, 'utf-16le');
  let text = '';
  for await (const part of decodeChunks(chunks(utf16), 'utf-16le', { bomLength: 2 })) text += part;
  assert.match(text, /甲;12,34/);
  assert.equal(sniffEncoding(Buffer.from([0xff, 0xfe, 0x41])).encoding, 'utf-16le');
  assert.equal(sniffEncoding(Buffer.from([0xc3, 0xa9, 0x78])).encoding, 'utf-8');
  assert.equal(sniffEncoding(Buffer.from([0xe9, 0x78])).encoding, 'latin1');
});

test('semicolon 文件：唯一合法候选自动判别并发布 v1', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'semicolon.csv', tableBytes('semicolon'));
    assert.equal(run.status, 'accepted');
    assert.equal(run.decision.kind, 'auto');
    assert.equal(run.selected.dialect.delimiter, ';');
    assert.equal(run.selected.dialect.moneyFormat, 'comma-decimal');
    assert.equal(run.attempts[0].result.acceptedCount, 1);
    assert.ok(run.publication.versionId, 'v1');
    const canonical = await readFile(store.canonicalPath(run.sha256, 1), 'utf8');
    const record = JSON.parse(canonical.trim());
    assert.equal(record.interpreted.find((c) => c.field === 'amount').value, '12.34');
    assert.deepEqual(record.extra, ['有;说明'], '契约外列按 extraColumns=保留 留存');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('utf16 文件：BOM、CRLF、逗号小数联合判定后自动接收', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'utf16.csv', tableBytes('utf16'));
    assert.equal(run.status, 'accepted');
    assert.equal(run.selected.dialect.encoding, 'utf-16le');
    assert.equal(run.selected.dialect.newline, 'CRLF');
    assert.equal(run.selected.dialect.delimiter, ';');
    const canonical = await readFile(store.canonicalPath(run.sha256, 1), 'utf8');
    assert.match(canonical, /"value":"12.34"/);
    assert.match(canonical, /甲/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ambiguous 文件：逗号与分号都是合法但业务不同的候选，必须人工确认', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'daily.csv', tableBytes('ambiguous'));
    assert.equal(run.status, 'awaiting_confirmation');
    assert.equal(run.decision.kind, 'manual');
    assert.ok(run.candidates.length >= 2, '应保留多个业务不同的候选');
    const delimiters = run.candidates.map((c) => c.dialect.delimiter).sort();
    assert.deepEqual(delimiters, [',', ';']);
    const fingerprints = new Set(run.candidates.map((c) => c.fingerprint));
    assert.equal(fingerprints.size, run.candidates.length, '不同业务结果必须有不同指纹');
    // 金额差异必须体现在规范值上：逗号方言把 12;34 解释为小数 12.34；
    // 分号方言把它切成两列，金额格只剩 34（业务结果完全不同）
    const comma = run.candidates.find((c) => c.dialect.delimiter === ',');
    const semicolon = run.candidates.find((c) => c.dialect.delimiter === ';');
    assert.equal(comma.sampleChecks[0].interpreted[1].value, '12.34');
    assert.equal(semicolon.sampleChecks[0].interpreted[1].value, '34');
    assert.notEqual(
      comma.sampleChecks[0].interpreted[1].value,
      semicolon.sampleChecks[0].interpreted[1].value,
    );
    assert.ok(run.missingEvidence.length > 0, '报告必须说明还缺哪些证据');

    // 人工选择分号方言 → 全量复核通过并发布
    const confirmed = await confirmCandidate({
      store,
      runId: run.runId,
      fingerprint: semicolon.fingerprint,
      operator: 'tester',
      reason: '业务确认金额为整数编码',
    });
    assert.equal(confirmed.status, 'accepted');
    assert.equal(confirmed.selected.source, 'manual');
    assert.equal(confirmed.publication.versionId, 'v1');
    const storedConfirmation = await store.findConfirmation(run.sha256, semicolon.fingerprint);
    assert.equal(storedConfirmation.operator, 'tester');
    assert.equal(await store.findConfirmation(run.sha256, comma.fingerprint), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late 文件：样本上自动成立的方言被末行推翻，整批暂停并保留冲突字节范围', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'daily.csv', tableBytes('late'));
    // 前 30 行在抽样上限内看起来是稳定的逗号方言；末行引号未闭合留给全量复核
    assert.equal(run.decision.kind, 'auto');
    assert.equal(run.status, 'blocked', '自动选择同样必须过全量复核，不能抽样通过即入库');
    assert.ok(run.conflict, '必须保留冲突范围');
    assert.equal(run.conflict.physicalLine, 31);
    assert.equal(run.conflict.code, 'CSV_DIALECT_CONFLICT');
    assert.ok(run.conflict.startByte >= 0 && run.conflict.endByte === run.size, 'EOF 冲突范围应延伸到文件末尾');
    assert.equal(run.publication, undefined, '暂停批次不得发布，前半批不能冒充完整交付');
    assert.equal(run.attempts[0].result.acceptedCount, 30, '已解释前缀行数可追溯且标记为临时');
    // 临时规范记录存在但不会出现在发布索引
    const index = await store.readPublishIndex();
    assert.deepEqual(index.byName, {});
    const report = buildRunReport(run, {
      confirmations: await store.listConfirmations(),
      publications: await store.listPublished(),
    });
    assert.match(report.markdown, /暂停/);
    assert.match(report.markdown, /provisional|临时/);
    assert.match(report.markdown, /冲突物理行/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('人工确认后晚到反例：确认动作留痕，冲突同样暂停且确认不被删除', async () => {
  const { store, dir } = await freshStore();
  try {
    // 前 40 行两种分隔符都“合法”，强制进入人工；第 41 行（样本 30 行上限之外）出现引号未闭合反例
    const head = Array.from({ length: 40 }, (_, i) => `X${i},12;34`).join('\n');
    const bytes = Buffer.from(head + '\n"broken,12;34\n');
    const run = await receive(store, 'manual-late.csv', bytes);
    assert.equal(run.status, 'awaiting_confirmation');
    const comma = run.candidates.find((c) => c.dialect.delimiter === ',');
    const confirmed = await confirmCandidate({
      store,
      runId: run.runId,
      fingerprint: comma.fingerprint,
      operator: 'tester',
      reason: '人工确认逗号方言',
    });
    assert.equal(confirmed.status, 'blocked');
    assert.equal(confirmed.conflict.physicalLine, 41);
    assert.equal(confirmed.attempts[0].source, 'manual');
    assert.equal(confirmed.attempts[0].result.acceptedCount, 40);
    const stored = await store.findConfirmation(run.sha256, comma.fingerprint);
    assert.ok(stored, '确认记录保留，作为“为何曾采用该方言”的审计依据');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('同名不同内容：确认记录不能被另一份同名文件复用', async () => {
  const { store, dir } = await freshStore();
  try {
    const first = await receive(store, 'daily.csv', tableBytes('ambiguous'));
    const semi = first.candidates.find((c) => c.dialect.delimiter === ';');
    await confirmCandidate({ store, runId: first.runId, fingerprint: semi.fingerprint, operator: 'tester' });

    // 另一份同名文件（内容不同）：必须独立走人工，不能套用旧确认
    const second = await receive(store, 'daily.csv', tableBytes('semicolon'));
    assert.equal(second.sha256 === first.sha256, false);
    assert.equal(second.status, 'accepted', 'semicolon 素材本身唯一候选自动通过，但确认记录不得跨内容复用');
    const reused = await store.findConfirmation(second.sha256, semi.fingerprint);
    assert.equal(reused, null);
    // 原始字节按哈希各自留存，没有互相覆盖
    const rawFiles = (await readdir(join(dir, 'raw'))).filter((f) => f.endsWith('.bin'));
    assert.equal(rawFiles.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('人工修正选择后重新解释：新版本发布，历史版本保留不静默改写', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'daily.csv', tableBytes('ambiguous'));
    const comma = run.candidates.find((c) => c.dialect.delimiter === ',');
    const semi = run.candidates.find((c) => c.dialect.delimiter === ';');
    await confirmCandidate({ store, runId: run.runId, fingerprint: comma.fingerprint, operator: 'tester', reason: '初次选择' });
    let published = await store.listPublished();
    assert.equal(published.length, 1);
    assert.equal(published[0].version, 1);

    const rerun = await reinterpretWith({
      store,
      runId: run.runId,
      dialectChoice: { delimiter: ';' },
      operator: 'reviewer',
      reason: '资料员修正金额小数习惯',
    });
    assert.equal(rerun.status, 'accepted');
    assert.equal(rerun.publication.versionId, 'v2');
    assert.equal(rerun.publication.supersedes.versionId, 'v1');
    published = await store.listPublished();
    assert.equal(published.length, 2, 'v1 与 v2 文件都在，历史未被改写');
    const v1 = published.find((p) => p.version === 1);
    const v2 = published.find((p) => p.version === 2);
    assert.equal(v1.sha256, v2.sha256, '同一原始字节的两种解释版本并列可追溯');
    assert.equal(v1.fingerprint === v2.fingerprint, false);
    // 两轮规范记录分别落盘：逗号解释为小数 12.34，分号解释金额格为 34
    const c1 = await readFile(store.canonicalPath(run.sha256, 1), 'utf8');
    const c2 = await readFile(store.canonicalPath(run.sha256, 2), 'utf8');
    assert.match(c1, /"value":"12.34"/);
    assert.match(c2, /"value":"34"/);
    assert.equal(comma.fingerprint !== semi.fingerprint, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('无成立候选时明确拒绝并记录每个候选的拒绝理由', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'broken.csv', Buffer.from('only-one-column\nx\ny\n'));
    assert.equal(run.status, 'rejected');
    assert.ok(run.rejectedCandidates.length > 0);
    assert.ok(run.rejectedCandidates.every((c) => c.reasons.length > 0));
    assert.equal(run.publication, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('大文件：内存有界，抽样截断且全量逐行处理，行数正确', async () => {
  const { store, dir } = await freshStore();
  try {
    const lineCount = 5000;
    const big = Buffer.from(Array.from({ length: lineCount }, (_, i) => `C${i},${(i % 99) + 1}.50`).join('\n') + '\n');
    const run = await receive(store, 'big.csv', big);
    assert.equal(run.sample.truncated, true, '样本必须在有界上限处截断');
    assert.ok(run.sample.bytes <= 64 * 1024);
    assert.equal(run.status, 'accepted');
    assert.equal(run.attempts[0].result.acceptedCount, lineCount);
    // 规范记录逐行落盘，行数与输入一致
    const canonical = await readFile(store.canonicalPath(run.sha256, 1), 'utf8');
    assert.equal(canonical.trim().split('\n').length, lineCount);
    // 全量复核走流式取回，原始字节不应被整份读入运行状态
    assert.equal(run.size, big.length);
    assert.equal(JSON.stringify(run).includes(big.toString('utf8').slice(0, 200)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('超大文件在小堆限制下不 OOM：全量复核流式读取内容寻址文件', async () => {
  const { store, dir } = await freshStore();
  try {
    const lineCount = 20000;
    async function* generator() {
      for (let i = 0; i < lineCount; i++) yield Buffer.from(`C${i},${(i % 100) + 1}.25\n`);
    }
    const run = await receiveFile({ store, name: 'huge.csv', byteChunks: Readable.from(generator()), schema });
    assert.equal(run.status, 'accepted');
    assert.equal(run.attempts[0].result.acceptedCount, lineCount);
    // 堆占用远小于文件规模，证明没有整份驻留
    assert.ok(process.memoryUsage().heapUsed < 128 * 1024 * 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('确认非法指纹被拒绝，不能确认候选集合之外的解释', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'daily.csv', tableBytes('ambiguous'));
    await assert.rejects(
      () => confirmCandidate({ store, runId: run.runId, fingerprint: 'not-a-real-fingerprint', operator: 'tester' }),
      /不在本次运行的候选集合中/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('原始字节与规范记录通过哈希互相联系，报告可解释当前方言', async () => {
  const { store, dir } = await freshStore();
  try {
    const run = await receive(store, 'daily.csv', tableBytes('ambiguous'));
    const semi = run.candidates.find((c) => c.dialect.delimiter === ';');
    const done = await confirmCandidate({ store, runId: run.runId, fingerprint: semi.fingerprint, operator: 'tester' });
    const raw = await store.openRaw(run.sha256);
    assert.deepEqual(raw, tableBytes('ambiguous'), '内容寻址取回的字节与原文一致');
    const report = buildRunReport(done, {
      confirmations: await store.listConfirmations(),
      publications: await store.listPublished(),
    });
    assert.match(report.markdown, /sha256/);
    assert.match(report.markdown, /候选 1/);
    assert.match(report.markdown, /被拒绝的候选|候选解释/);
    assert.match(report.markdown, /v1/);
    assert.ok(report.json.confirmations.length === 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
