/** 发送侧字节变换：HEX 解析、回车换行、校验附加。 */

export type ChecksumKind = "none" | "sum" | "crc8" | "crc16modbus";

export function checksumLabel(kind: ChecksumKind): string {
  return kind === "sum"
    ? "SUM 累加和"
    : kind === "crc8"
      ? "CRC8"
      : kind === "crc16modbus"
        ? "CRC16 MODBUS"
        : "None";
}

/** 宽容解析 HEX 输入："68 03 00 1A" / "6803001A" / "0x68,0x03" 均可。 */
export function parseHexInput(input: string): Uint8Array {
  const cleaned = input.replace(/(0x|0X)/g, "").replace(/[\s,;-]+/g, "");
  if (!cleaned) throw new Error("HEX 内容为空");
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error("HEX 含非法字符");
  if (cleaned.length % 2 !== 0) throw new Error("HEX 字符数须为偶数");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function strToUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function applyCrlf(bytes: Uint8Array, add: boolean): Uint8Array {
  if (!add) return bytes;
  const n = bytes.length;
  if (n >= 2 && bytes[n - 2] === 13 && bytes[n - 1] === 10) return bytes;
  if (n >= 1 && bytes[n - 1] === 10) return bytes;
  return concat(bytes, new Uint8Array([13, 10]));
}

/** CRC8：多项式 0x07，初值 0x00，不反射。 */
export function crc8(data: Uint8Array): number {
  let crc = 0x00;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** CRC16 MODBUS：多项式 0xA001（反射 0x8005），初值 0xFFFF，低字节在前。 */
export function crc16Modbus(data: Uint8Array): [number, number] {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return [crc & 0xff, (crc >> 8) & 0xff];
}

export function appendChecksum(kind: ChecksumKind, bytes: Uint8Array): Uint8Array {
  switch (kind) {
    case "sum": {
      let sum = 0;
      bytes.forEach((b) => (sum += b));
      return concat(bytes, new Uint8Array([sum & 0xff]));
    }
    case "crc8":
      return concat(bytes, new Uint8Array([crc8(bytes)]));
    case "crc16modbus": {
      const [lo, hi] = crc16Modbus(bytes);
      return concat(bytes, new Uint8Array([lo, hi]));
    }
    default:
      return bytes;
  }
}

/** 组装最终发送字节：HEX/文本 → 回车换行 → 校验。 */
export function buildTxPayload(
  input: string,
  hexMode: boolean,
  crlf: boolean,
  checksumKind: ChecksumKind,
): Uint8Array {
  let bytes = hexMode ? parseHexInput(input) : strToUtf8(input);
  if (bytes.length === 0) throw new Error("发送内容为空");
  bytes = applyCrlf(bytes, crlf);
  bytes = appendChecksum(checksumKind, bytes);
  return bytes;
}
