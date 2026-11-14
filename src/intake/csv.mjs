// RFC4180 风格的流式方言解析器：逐字符状态机，不缓存整份文件。
// 同时维护逻辑行序、物理行号与字节偏移，使后续“冲突范围”可定位到原始字节。

export class CsvDialectError extends Error {
  constructor(message, { physicalLine, byteOffset } = {}) {
    super(message);
    this.name = 'CsvDialectError';
    this.code = 'CSV_DIALECT_CONFLICT';
    this.physicalLine = physicalLine;
    this.byteOffset = byteOffset;
  }
}

const DEFAULT_MAX_FIELD_BYTES = 1_048_576; // 单字段 1 MiB 上限，防止单行把内存撑爆

export function parseCsvText(text, dialect, { maxFieldBytes = DEFAULT_MAX_FIELD_BYTES } = {}) {
  const chunks = (async function* () { yield { text, startByte: 0 }; })();
  return collectRows(streamCsv(chunks, dialect, { maxFieldBytes }));
}
export async function collectRows(rowStream) {
  const rows = [];
  for await (const row of rowStream) rows.push(row);
  return rows;
}

// chunks: AsyncIterable<{text:string, startByte:number}>；dialect: {delimiter, quote, encoding}
export async function* streamCsv(chunks, dialect, { maxFieldBytes = DEFAULT_MAX_FIELD_BYTES } = {}) {
  const { delimiter, quote = '"', encoding = 'utf-8' } = dialect;
  if (!delimiter || [...delimiter].length !== 1) throw new Error('分隔符必须是单个字符');
  let field = '';
  let fields = [];
  let quoted = false;
  let rowHasContent = false; // 区分空行（跳过）与真实数据行
  let physicalLine = 1;
  let rowIndex = 0;
  let rowStartByte = dialect.bomLength || 0;
  let fieldByteSize = 0;
  let pendingCr = false; // 非引号区跨块 CR 等待 LF
  let quoteStartLine = null; // 引号字段起始物理行，未闭合报错时定位用
  let quoteStartByte = null;

  function byteWidth(char) {
    if (encoding === 'utf-16le' || encoding === 'utf-16be') return 2;
    if (encoding === 'latin1') return 1;
    const code = char.codePointAt(0);
    if (code <= 0x7f) return 1;
    if (code <= 0x7ff) return 2;
    if (code <= 0xffff) return 3;
    return 4;
  }

  let chunkStartByte = 0;
  for await (const chunk of chunks) {
    chunkStartByte = chunk.startByte;
    let offsetInChunk = 0;
    const text = chunk.text;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const byteOffset = chunkStartByte + offsetInChunk;
      const width = byteWidth(char);
      if (pendingCr) {
        pendingCr = false;
        if (char === '\n') {
          physicalLine++;
          offsetInChunk += width;
          continue; // CRLF 已在 CR 处分行
        }
      }
      if (quoted) {
        if (char === quote) {
          if (text[i + 1] === quote) {
            field += quote;
            fieldByteSize += width;
            i++;
            offsetInChunk += width; // 被跳过的那个引号同样占字节
          } else {
            quoted = false;
            quoteStartLine = null;
            quoteStartByte = null;
          }
        } else if (char === '\n' || char === '\r') {
          field += char;
          fieldByteSize += width;
          if (char === '\n') physicalLine++;
        } else {
          field += char;
          fieldByteSize += width;
        }
      } else {
        if (char === delimiter) {
          fields.push(field);
          field = '';
          fieldByteSize = 0;
          rowHasContent = true;
        } else if (char === quote && field === '') {
          quoted = true;
          quoteStartLine = physicalLine;
          quoteStartByte = byteOffset;
          rowHasContent = true;
        } else if (char === '\n' || char === '\r') {
          if (char === '\r') {
            if (text[i + 1] === '\n') {
              i++;
              offsetInChunk += width;
            } else if (i + 1 >= text.length) {
              pendingCr = true; // 可能是跨块 CRLF，下一块开头判断
            }
          }
          physicalLine++;
          if (rowHasContent) {
            fields.push(field);
            yield {
              index: rowIndex++,
              physicalLine: physicalLine - 1,
              startByte: rowStartByte,
              endByte: byteOffset + width,
              fields,
            };
            fields = [];
          }
          field = '';
          fieldByteSize = 0;
          rowHasContent = false;
          rowStartByte = byteOffset + width;
        } else if (char === quote) {
          // RFC4180：引号只在字段起点承担引用语法；非引号字段内出现的引号按普通字符处理
          field += char;
          fieldByteSize += width;
          rowHasContent = true;
        } else {
          field += char;
          fieldByteSize += width;
          rowHasContent = true;
        }
      }
      if (fieldByteSize > maxFieldBytes) {
        throw new CsvDialectError(`第 ${physicalLine} 行单字段超过 ${maxFieldBytes} 字节上限`, {
          physicalLine,
          byteOffset,
        });
      }
      offsetInChunk += width;
    }
  }
  if (quoted) {
    throw new CsvDialectError(`第 ${quoteStartLine ?? physicalLine} 行开始的引号字段在文件结束前未闭合，该方言无法完整解释此文件`, {
      physicalLine: quoteStartLine ?? physicalLine,
      byteOffset: quoteStartByte ?? chunkStartByte,
    });
  }
  if (rowHasContent || field !== '' || fields.length > 0) {
    yield {
      index: rowIndex,
      physicalLine,
      startByte: rowStartByte,
      endByte: null,
      fields: [...fields, field],
    };
  }
}
