// 字段语义契约：来源不总有可靠表头，因此表头只作为候选证据之一，
// 最终按字段顺序与类型校验。extraColumns=保留 时不拒绝宽行。

import { interpretCell } from './money.mjs';

export function loadSchema(schemaObject) {
  if (!schemaObject || !Array.isArray(schemaObject.fields) || schemaObject.fields.length === 0) {
    throw new Error('契约必须包含非空 fields 数组');
  }
  for (const field of schemaObject.fields) {
    if (!field.name || !field.type) throw new Error(`字段定义不完整：${JSON.stringify(field)}`);
    if (!['string', 'decimal'].includes(field.type)) throw new Error(`暂不支持的字段类型：${field.type}`);
  }
  return {
    fields: schemaObject.fields,
    extraColumns: schemaObject.extraColumns ?? '拒绝',
    header: schemaObject.header ?? '可选',
  };
}

// 表头识别：在契约对齐位置命中字段名即采信为表头（允许契约外的额外列）。
// 错位切分（如分号切分把 "code,amount" 整体放进第一格）不会在任何对齐位置命中，
// 因此自然不采信，首行回到数据行参与类型校验，由类型校验完成把关。
export function detectHeader(firstRowFields, schema) {
  if (!firstRowFields) return { hasHeader: false, evidence: ['抽样中没有任何行，无法识别表头'] };
  const hits = [];
  firstRowFields.forEach((cell, index) => {
    const token = String(cell).trim().toLowerCase();
    const expected = schema.fields[index]?.name;
    if (expected && token === expected) hits.push({ index, name: token });
  });
  if (hits.length >= 1 && firstRowFields.length >= schema.fields.length) {
    return {
      hasHeader: true,
      hits,
      evidence: [
        firstRowFields.length === schema.fields.length
          ? `首行宽度与契约对齐（${firstRowFields.length} 列）且命中字段 ${hits.map((h) => h.name).join('、')}，按表头处理并跳过`
          : `首行命中字段 ${hits.map((h) => h.name).join('、')}，另有 ${firstRowFields.length - schema.fields.length} 个契约外列，按表头处理并跳过`,
      ],
    };
  }
  return { hasHeader: false, evidence: ['首行未在契约对齐位置命中字段名，按无表头数据处理'] };
}

// 表头画像：不依赖切分是否对齐，独立判断首行“像不像表头”。
// 用于错位切分场景——该切分本身可能仍合法（数据行类型成立），只是首行是被切坏的表头。
// 评分依据：命中契约字段名、含说明性词汇、decimal 列位置不是可解释数字。
const HEADER_KEYWORDS = ['code', 'amount', 'value', 'note', 'name', 'id', '金额', '编码', '说明', '备注', '名称'];

export function headerLikeness(firstRowFields, schema) {
  if (!firstRowFields || firstRowFields.length === 0) return { score: 0, signals: [] };
  const signals = [];
  let score = 0;
  const fieldNames = new Set(schema.fields.map((f) => f.name.toLowerCase()));
  for (const cell of firstRowFields) {
    const token = String(cell).trim().toLowerCase();
    if (fieldNames.has(token)) { score += 2; signals.push(`单元格“${cell}”是契约字段名`); }
    for (const keyword of HEADER_KEYWORDS) {
      if (token !== keyword && token.includes(keyword)) { score += 1; signals.push(`单元格“${cell}”含表头词汇 ${keyword}`); break; }
    }
  }
  // decimal 契约列对应的首行单元格无法解释为数字 → 强烈说明它是列标题
  const decimalIndex = schema.fields.findIndex((f) => f.type === 'decimal');
  if (decimalIndex >= 0) {
    const cell = firstRowFields[decimalIndex];
    if (cell !== undefined && !/^[+-]?[\d.,; ]+$/.test(String(cell).trim())) {
      score += 2;
      signals.push(`decimal 列位置的首行值“${cell}”不是数字形态，符合列标题特征`);
    }
  }
  return { score, signals };
}

// 对一行做类型与必填校验，返回逐字段结果；金额按指定金额格式解释。
export function validateRow(fields, schema, moneyFormatId, { rowIndex, physicalLine } = {}) {
  const problems = [];
  const interpreted = [];
  const requiredCount = schema.fields.length;
  if (fields.length < requiredCount) {
    problems.push(`列数 ${fields.length} 少于契约必填字段数 ${requiredCount}`);
  }
  schema.fields.forEach((field, index) => {
    const raw = fields[index];
    if (raw === undefined || String(raw).trim() === '') {
      if (field.required) problems.push(`字段 ${field.name}（第 ${index + 1} 列）缺失或为空`);
      interpreted.push({ field: field.name, type: field.type, raw: raw ?? null, value: null });
      return;
    }
    if (field.type === 'string') {
      interpreted.push({ field: field.name, type: 'string', raw, value: String(raw) });
    } else if (field.type === 'decimal') {
      const result = interpretCell(raw, moneyFormatId);
      if (!result.ok) {
        problems.push(`字段 ${field.name}（第 ${index + 1} 列）值“${raw}”无法按 ${moneyFormatId} 解释：${result.reason}`);
        interpreted.push({ field: field.name, type: 'decimal', raw, value: null, error: result.reason });
      } else {
        interpreted.push({ field: field.name, type: 'decimal', raw, value: result.canonical, basis: result.basis, weak: result.weak });
      }
    }
  });
  if (fields.length > requiredCount && schema.extraColumns !== '保留') {
    problems.push(`存在 ${fields.length - requiredCount} 个契约外列，而契约要求 ${schema.extraColumns}`);
  }
  const extra = schema.extraColumns === '保留' ? fields.slice(requiredCount) : [];
  return {
    ok: problems.length === 0,
    problems,
    rowIndex,
    physicalLine,
    interpreted,
    extra,
  };
}
