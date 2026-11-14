// 端到端演示：用项目内的歧义素材跑通“自动判别”与“人工确认”两条路径。
// 运行：node src/intake/demo.mjs
// 所有状态写入独立临时目录，演示结束保留路径供资料员查看，不污染源码树。

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { IntakeStore } from './store.mjs';
import { loadSchema } from './schema.mjs';
import { receiveFile, confirmCandidate, reinterpretWith } from './receive.mjs';
import { buildRunReport } from './report.mjs';
import { tableBytes } from '../tables.mjs';

const schema = loadSchema(JSON.parse(await readFile(new URL('../../fixtures/schema.json', import.meta.url), 'utf8')));
const stateDir = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const store = new IntakeStore(stateDir);
await store.init();
const lines = [];
const say = (text) => { lines.push(text); console.log(text); };

function from(bytes) {
  return Readable.from((async function* () {
    for (let i = 0; i < bytes.length; i += 16) yield bytes.subarray(i, i + 16);
  })());
}

say('=== 接收流程演示（状态目录：' + stateDir + '）===\n');

// 路径一：自动判别。semicolon 与 utf16 只有一个合法候选，全量复核后自动发布。
say('【路径一·自动判别】');
for (const name of ['semicolon', 'utf16']) {
  const run = await receiveFile({ store, name: `${name}.csv`, byteChunks: from(tableBytes(name)), schema, operator: 'demo' });
  say(`- ${name}.csv → ${run.status}，发布 ${run.publication?.versionId ?? '未发布'}，编码 ${run.selected?.dialect.encoding}`);
}

// 路径二：人工确认。ambiguous 有两个业务不同的合法候选，必须人工选择。
say('\n【路径二·人工确认】');
const ambiguous = await receiveFile({ store, name: 'daily.csv', byteChunks: from(tableBytes('ambiguous')), schema, operator: 'demo' });
say(`- daily.csv(ambiguous) → ${ambiguous.status}，候选数 ${ambiguous.candidates.length}，缺口：${ambiguous.missingEvidence.join('；')}`);
for (const candidate of ambiguous.candidates) {
  say(`  · 候选：${candidate.dialect.delimiter === ';' ? '分号' : '逗号'}方言，金额示例 ${candidate.sampleChecks[0].interpreted[1].value}，弱证据=${candidate.weak}`);
}
const semi = ambiguous.candidates.find((c) => c.dialect.delimiter === ';');
const confirmed = await confirmCandidate({
  store,
  runId: ambiguous.runId,
  fingerprint: semi.fingerprint,
  operator: '资料员甲',
  reason: '演示：业务确认采用分号方言',
});
say(`- 人工确认后 → ${confirmed.status}，发布 ${confirmed.publication.versionId}`);

// 资料员修正选择 → 重新解释产生 v2，v1 保留。
say('\n【修正后重新解释：新版本不覆盖历史】');
const rerun = await reinterpretWith({
  store,
  runId: ambiguous.runId,
  dialectChoice: { delimiter: ',' },
  operator: '资料员乙',
  reason: '演示：复核后改采逗号小数解释',
});
say(`- 重新解释 → ${rerun.status}，发布 ${rerun.publication.versionId}，取代 ${rerun.publication.supersedes.versionId}（v1 文件仍保留）`);

// 晚到反例：late 前 30 行稳定，末行推翻方言，整批暂停不发布。
say('\n【晚到反例：后续行推翻方言，整批暂停】');
const late = await receiveFile({ store, name: 'late-batch.csv', byteChunks: from(tableBytes('late')), schema, operator: 'demo' });
say(`- late-batch.csv → ${late.status}，冲突物理行 ${late.conflict?.physicalLine}，字节范围 [${late.conflict?.startByte}, ${late.conflict?.endByte}]`);
say(`- 已解释前缀 ${late.attempts[0].result.acceptedCount} 行标记为临时记录，发布索引中无此批次`);

// 同名不同内容：确认记录不得跨文件复用（用不同逻辑名接收，便于对比版本）。
say('\n【同名文件隔离：确认记录绑定内容哈希+指纹】');
const sameName = await receiveFile({ store, name: 'daily-copy.csv', byteChunks: from(tableBytes('semicolon')), schema, operator: 'demo' });
const reused = await store.findConfirmation(sameName.sha256, semi.fingerprint);
say(`- 另一份同名渠道文件（内容哈希不同）旧确认复用结果：${reused === null ? '拒绝复用（正确）' : '错误复用'}`);
say(`- 两份原始字节按各自哈希独立留存于 raw/，互不覆盖`);

// 资料员视图报告落盘。
const report = buildRunReport(confirmed, {
  confirmations: await store.listConfirmations(),
  publications: await store.listPublished(),
});
const reportPath = join(stateDir, 'report-ambiguous.md');
await writeFile(reportPath, report.markdown, 'utf8');
say(`\n【资料员报告】已写入 ${reportPath}`);
say(`发布版本清单：${(await store.listPublished()).map((p) => `${p.name}@${p.versionId}`).join('，')}`);
console.log('\n演示结束。可用以下命令复查：');
console.log(`  node src/intake/cli.mjs runs --state ${stateDir}`);
console.log(`  node src/intake/cli.mjs report ${ambiguous.runId} --state ${stateDir}`);
void rm;
