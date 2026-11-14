// 资料员视图：把一次接收的候选、依据、缺口、冲突与版本历史组织成可读报告。
// 同一份数据同时产出 Markdown（人读）与 JSON（系统读）。

import { describeDialect } from './dialect.mjs';

function line(label, value) {
  return `- ${label}：${value}`;
}

export function buildRunReport(run, { confirmations = [], publications = [] } = {}) {
  const md = [];
  md.push(`# 接收运行 ${run.runId}`);
  md.push('');
  md.push(line('来源文件名', run.name));
  md.push(line('内容哈希 sha256', run.sha256));
  md.push(line('字节数', run.size));
  md.push(line('当前状态', statusLabel(run.status)));
  md.push(line('编码判定', run.encoding?.encoding ?? '未知') + `（${(run.encoding?.evidence || []).join('；')}）`);
  md.push(line('抽样范围', `${run.sample?.bytes ?? 0} 字节 / ${run.sample?.lines ?? 0} 行${run.sample?.truncated ? `（达到${run.sample.limitedBy === 'bytes' ? '字节' : '行数'}上限，未整文件入内存）` : ''}`));
  md.push('');

  md.push('## 候选解释与依据');
  if (run.candidates.length === 0) md.push('- 无成立候选');
  run.candidates.forEach((candidate, index) => {
    md.push(`### 候选 ${index + 1}：${describeDialect(candidate.dialect)}`);
    md.push(line('解释指纹', candidate.fingerprint.slice(0, 32) + '…'));
    md.push(line('证据强度', candidate.weak ? '含弱证据（金额分隔符为推断结果）' : '强证据'));
    candidate.evidence.forEach((item) => md.push(`  - ${item}`));
    md.push('');
  });

  if (run.rejectedCandidates?.length) {
    md.push('## 被拒绝的候选（留痕，避免“只选一个不解释为什么”）');
    run.rejectedCandidates.forEach((candidate) => {
      md.push(`- 分隔符 ${JSON.stringify(candidate.delimiter)} / 引号 ${JSON.stringify(candidate.quote)}：${candidate.reasons.join('；')}`);
    });
    md.push('');
  }

  md.push('## 裁决');
  md.push(line('裁决类型', decisionLabel(run.decision?.kind)));
  md.push(line('裁决说明', run.decision?.reason ?? '—'));
  if (run.selected) {
    md.push(line('选定方言', describeDialect(run.selected.dialect)));
    md.push(line('选定方式', run.selected.source === 'auto' ? '系统自动（唯一合法候选）' : `人工（${run.selected.confirmationRef ?? '确认记录'}）`));
  }
  md.push('');

  md.push('## 还缺哪些证据');
  if (run.missingEvidence?.length) run.missingEvidence.forEach((item) => md.push(`- ${item}`));
  else md.push('- 暂无缺口');
  md.push('');

  md.push('## 尝试与未接收行');
  if (!run.attempts.length) md.push('- 尚未进入全量复核');
  for (const attempt of run.attempts) {
    md.push(`### 尝试 ${attempt.attempt}（${attempt.source}，操作人 ${attempt.operator}）`);
    md.push(line('方言', describeDialect(attempt.dialect)));
    if (attempt.result.ok) {
      md.push(line('结果', `全量通过，接收 ${attempt.result.acceptedCount} 行`));
      md.push(line('规范记录', attempt.result.canonicalRef.path ?? '（已落盘）'));
    } else {
      const c = attempt.result.conflict;
      md.push(line('结果', '暂停：后续行推翻该方言，整批未作为完整交付发布'));
      md.push(line('冲突物理行', c.physicalLine ?? '未知'));
      md.push(line('冲突字节范围', `[${c.startByte ?? '?'}, ${c.endByte ?? '流末'}]`));
      md.push(line('冲突原因', (c.problems || []).join('；')));
      if (c.rawFields) md.push(line('冲突原文切格', JSON.stringify(c.rawFields)));
      md.push(line('已解释前缀', `${attempt.result.acceptedCount} 行仅保留为临时规范记录，状态 provisional，不可作为交付`));
    }
    md.push('');
  }

  md.push('## 确认记录（与内容哈希+指纹绑定）');
  const related = confirmations.filter((c) => c.sha256 === run.sha256);
  if (!related.length) md.push('- 本内容暂无确认记录');
  related.forEach((c) => {
    md.push(`- ${c.confirmedAt} ${c.operator}：${c.reason}（键 ${c.key.slice(0, 28)}…，指纹 ${c.fingerprint.slice(0, 20)}…）`);
  });
  md.push('');

  md.push('## 发布版本（历史不可变，修正只产生新版本）');
  const versions = publications.filter((p) => p.sha256 === run.sha256 || p.name === run.name);
  if (!versions.length) md.push('- 尚无发布版本（暂停/挂起批次不会出现在这里）');
  versions
    .sort((a, b) => a.version - b.version)
    .forEach((p) => {
      md.push(`- ${p.versionId} ${p.publishedAt} 操作人 ${p.operator} 哈希 ${p.sha256.slice(0, 12)}…${p.supersedes ? `（取代 ${p.supersedes.versionId}）` : ''}`);
    });

  const json = {
    runId: run.runId,
    name: run.name,
    sha256: run.sha256,
    status: run.status,
    encoding: run.encoding,
    sample: run.sample,
    decision: run.decision,
    candidates: run.candidates,
    rejectedCandidates: run.rejectedCandidates,
    selected: run.selected,
    missingEvidence: run.missingEvidence,
    attempts: run.attempts,
    conflict: run.conflict ?? null,
    confirmations: related,
    publications: versions,
  };
  return { markdown: md.join('\n') + '\n', json };
}

function statusLabel(status) {
  return {
    probing: '探测中',
    awaiting_confirmation: '等待人工确认',
    validating: '全量复核中',
    blocked: '已暂停（后续行冲突）',
    accepted: '已接收并发布',
    rejected: '已拒绝（无成立候选）',
  }[status] || status;
}

function decisionLabel(kind) {
  return { auto: '自动选择（唯一合法候选）', manual: '人工确认（多个业务不同的合法候选）', reject: '拒绝（无成立候选）' }[kind] ?? kind ?? '—';
}
