// 金额（decimal）字段的格式解释。
// 渠道习惯不一致：点号小数（1,234.56）、逗号小数（1.234,56），以及只出现单一
// 分隔符时需要结合“小数位数/分隔符角色”推断的弱证据情形。
// 每个单元格的解释都返回依据，不做静默猜测。

export const MONEY_FORMATS = {
  'dot-decimal': { id: 'dot-decimal', decimal: '.', grouping: ',', label: '点号小数（如 1,234.56 或 12.34）' },
  'comma-decimal': { id: 'comma-decimal', decimal: ',', grouping: '.', label: '逗号小数（如 1.234,56 或 12,34）' },
  // 推断型：单元格内只出现一种分隔符时，按“小数位数/分组规则”推断，证据较弱，
  // 必须在候选记录里显式标注，人工确认时可见。
  inferred: { id: 'inferred', label: '按单元格特征推断分隔符角色（弱证据）' },
};

const INTEGER_RE = /^[+-]?\d+$/;
const GROUP_RULE = /^\d{1,3}(\.\d{3})+$/; // 12.345
const DEC_RULE_2 = /^\d+,\d{2}$/; // 12,34
const DEC_RULE_3 = /^\d+,\d{3}$/; // 12,345（歧义：三位小数或分组，按上下文裁决）
const DOT_GROUP_RULE = /^\d{1,3}(,\d{3})+$/; // 12,345
const DOT_DEC_RULE = /^\d+\.\d+$/; // 12.34

function onlyDigitsAndSeparators(value) {
  return /^[+-]?[\d.,; ]+$/.test(value);
}

// 单格解释；返回 {ok, canonical, format, basis, weak}
export function interpretCell(rawValue, formatId) {
  const value = String(rawValue ?? '').trim();
  if (value === '') return { ok: false, reason: '空单元格' };
  if (INTEGER_RE.test(value)) {
    return { ok: true, canonical: value.replace('+', ''), format: 'integer', basis: '纯整数，无小数分隔符', weak: false };
  }
  if (!onlyDigitsAndSeparators(value)) return { ok: false, reason: '含数字与分隔符之外的字符' };

  if (formatId === 'dot-decimal') {
    if (DOT_DEC_RULE.test(value) || /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) {
      return {
        ok: true,
        canonical: value.replace(/,/g, ''),
        format: formatId,
        basis: '点号为小数点，逗号为千分位',
        weak: false,
      };
    }
    return { ok: false, reason: '不符合点号小数格式（点号小数允许 12.34 / 1,234.56）' };
  }

  if (formatId === 'comma-decimal') {
    if (DEC_RULE_2.test(value) || /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(value)) {
      return {
        ok: true,
        canonical: value.replace(/\./g, '').replace(',', '.'),
        format: formatId,
        basis: '逗号为小数点，点号为千分位',
        weak: false,
      };
    }
    if (DEC_RULE_3.test(value)) {
      return {
        ok: true,
        canonical: value.replace(',', '.'),
        format: formatId,
        basis: '三位逗号数字按逗号小数解释（与分组解释存在歧义，见推断记录）',
        weak: true,
      };
    }
    return { ok: false, reason: '不符合逗号小数格式（逗号小数允许 12,34 / 1.234,56）' };
  }

  if (formatId === 'inferred') return inferCell(value);
  return { ok: false, reason: `未知金额格式 ${formatId}` };
}

// 弱证据推断：只处理“单一分隔符”的单元格，角色由结构决定。
export function inferCell(value) {
  if (INTEGER_RE.test(value)) {
    return { ok: true, canonical: value.replace('+', ''), format: 'integer', basis: '纯整数', weak: false };
  }
  if (DEC_RULE_2.test(value)) {
    return { ok: true, canonical: value.replace(',', '.'), format: 'comma-decimal', basis: '逗号后恰好两位，判为小数', weak: true };
  }
  if (GROUP_RULE.test(value)) {
    return { ok: true, canonical: value.replace(/\./g, ''), format: 'dot-decimal', basis: '点号按千分位分组（每组三位）', weak: true };
  }
  if (DOT_GROUP_RULE.test(value)) {
    return { ok: true, canonical: value.replace(/,/g, ''), format: 'dot-decimal', basis: '逗号按千分位分组（每组三位）', weak: true };
  }
  if (DOT_DEC_RULE.test(value)) {
    return { ok: true, canonical: value, format: 'dot-decimal', basis: '点号判为小数点', weak: true };
  }
  // 形如 12;34：分号作小数位的弱推断（本批歧义文件正是此形态）
  if (/^\d+;\d+$/.test(value)) {
    const digits = value.split(';');
    return {
      ok: true,
      canonical: `${digits[0]}.${digits[1]}`,
      format: 'inferred',
      basis: '分号在单元格内承担小数点角色（非标准，弱证据，需人工确认）',
      weak: true,
    };
  }
  return { ok: false, reason: '无法在弱证据规则下推断该数字的分隔符角色' };
}

// 解析一批候选单元格，汇总到文件级金额方言。
// 裁决顺序：穷尽所有格式后，强证据标准格式优先，弱证据推断兜底。
// preferredFormat 只用于在同等强度下优先呈现，不会跳过其他格式的尝试记录。
export function resolveMoneyFormat(cellSamples, preferredFormat) {
  const tried = [];
  const standard = preferredFormat
    ? [preferredFormat, ...['dot-decimal', 'comma-decimal'].filter((f) => f !== preferredFormat)]
    : ['dot-decimal', 'comma-decimal'];
  const order = [...new Set([...standard, 'inferred'])];
  const conforming = [];
  for (const formatId of order) {
    const results = cellSamples.map((cell, i) => ({ cell, index: i, ...interpretCell(cell, formatId) }));
    const failed = results.filter((r) => !r.ok);
    const weak = results.filter((r) => r.ok && r.weak);
    tried.push({ formatId, ok: failed.length === 0, failedCount: failed.length, weakCount: weak.length, failures: failed.slice(0, 5) });
    if (failed.length === 0) conforming.push({ formatId, results, weak: weak.length > 0 });
  }
  if (conforming.length === 0) {
    return { formatId: null, results: [], tried, weak: false, evidence: ['所有候选金额格式都有单元格无法解释'] };
  }
  const strong = conforming.find((c) => !c.weak && c.formatId !== 'inferred');
  const chosen = strong ?? conforming[0];
  return {
    formatId: chosen.formatId,
    results: chosen.results,
    tried,
    weak: chosen.weak,
    evidence: moneyEvidence(chosen.formatId, chosen.results, chosen.weak),
  };
}

function moneyEvidence(formatId, results, weak) {
  const sample = results.slice(0, 3).map((r) => `“${r.cell}”→${r.canonical}（${r.basis}）`);
  const weakNote = weak ? '；含弱证据单元格，需要人工复核' : '';
  return [`金额格式 ${MONEY_FORMATS[formatId]?.label ?? formatId}：${sample.join('；')}${weakNote}`];
}
