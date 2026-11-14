// 编码识别与有界流式解码。
// 判定依据（BOM、严格解码结果）全部以证据形式返回，供候选记录与报告使用。

export class EncodingError extends Error {
  constructor(message, { byteOffset, encoding } = {}) {
    super(message);
    this.name = 'EncodingError';
    this.code = 'ENCODING_INVALID';
    this.byteOffset = byteOffset;
    this.encoding = encoding;
  }
}

const BOM_TABLE = [
  { signature: Buffer.from([0xef, 0xbb, 0xbf]), encoding: 'utf-8', bomLength: 3 },
  { signature: Buffer.from([0xff, 0xfe]), encoding: 'utf-16le', bomLength: 2 },
  { signature: Buffer.from([0xfe, 0xff]), encoding: 'utf-16be', bomLength: 2 },
];

export function detectBom(head) {
  for (const bom of BOM_TABLE) {
    if (head.length >= bom.signature.length && head.subarray(0, bom.signature.length).equals(bom.signature)) {
      return { encoding: bom.encoding, bomLength: bom.bomLength };
    }
  }
  return null;
}

// 只读取有界前缀做判定，不把整份文件读入内存。
export function sniffEncoding(headBytes) {
  const bom = detectBom(headBytes);
  if (bom) {
    return {
      encoding: bom.encoding,
      bomLength: bom.bomLength,
      evidence: [`检测到 ${bom.encoding.toUpperCase()} BOM（前 ${bom.bomLength} 字节），编码按 BOM 判定`],
    };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(headBytes);
    return {
      encoding: 'utf-8',
      bomLength: 0,
      evidence: ['无 BOM；前缀以 UTF-8 严格模式解码成功，全量解码仍会再次校验'],
    };
  } catch {
    return {
      encoding: 'latin1',
      bomLength: 0,
      evidence: ['无 BOM 且前缀不是合法 UTF-8 序列，回退按 Latin-1 单字节解释'],
    };
  }
}

function latin1Decode(buffer) {
  return buffer.toString('latin1');
}

// 流式解码：逐块产出文本，多字节字符跨块由 TextDecoder 的 stream 模式处理。
// bomLength 仅作用于文件首块；bytesRead 向外暴露累计读取字节，便于错误定位。
export async function* decodeChunks(byteChunks, encoding, { bomLength = 0 } = {}) {
  const state = { bytesRead: 0, first: true };
  if (encoding === 'latin1') {
    for await (const chunk of byteChunks) {
      state.bytesRead += chunk.length;
      const buf = state.first && bomLength > 0 ? chunk.subarray(bomLength) : chunk;
      state.first = false;
      yield latin1Decode(buf);
    }
    return state;
  }
  const decoder = new TextDecoder(encoding, { fatal: true });
  try {
    for await (const chunk of byteChunks) {
      state.bytesRead += chunk.length;
      const buf = state.first && bomLength > 0 ? chunk.subarray(bomLength) : chunk;
      state.first = false;
      yield decoder.decode(buf, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } catch (error) {
    throw new EncodingError(`按 ${encoding} 全量解码失败：${error.message}`, {
      byteOffset: state.bytesRead,
      encoding,
    });
  }
  return state;
}

// 单字符在该编码下的字节宽度，供解析器维护精确字节偏移（冲突范围要可定位到字节）。
export function charByteSize(char, encoding) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return 2;
  if (encoding === 'latin1') return 1;
  const code = char.codePointAt(0);
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}
