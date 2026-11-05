/** Values that can appear in an index key (Dexie-shaped scalars). */
export type IndexValue = null | boolean | number | string | Uint8Array;

const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_NUM = 0x10;
const TAG_STR = 0x20;
const TAG_BIN = 0x21;

const encoder = new TextEncoder();

/** Order-preserving big-endian float64 (sortable as unsigned bytes). */
export function encodeOrderFloat64(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, n, false);
  const u = new Uint8Array(buf);
  if ((u[0] ?? 0) & 0x80) {
    for (let i = 0; i < 8; i++) u[i] = (u[i] ?? 0) ^ 0xff;
  } else {
    u[0] = (u[0] ?? 0) ^ 0x80;
  }
  return u;
}

export function decodeOrderFloat64(u: Uint8Array, offset = 0): number {
  const copy = u.slice(offset, offset + 8);
  if ((copy[0] ?? 0) & 0x80) {
    copy[0] = (copy[0] ?? 0) ^ 0x80;
  } else {
    for (let i = 0; i < 8; i++) copy[i] = (copy[i] ?? 0) ^ 0xff;
  }
  return new DataView(copy.buffer, copy.byteOffset, 8).getFloat64(0, false);
}

/**
 * Lexicographic, prefix-safe UTF-8 encoding: `0x00` becomes `0x00 0xff` and
 * the value ends with `0x00 0x00`. Byte order of the result is the byte order
 * of the original string, so `orderBy` on a string index is A–Z (not
 * length-first).
 */
function encodeSortedString(body: Uint8Array): Uint8Array {
  let zeros = 0;
  for (let i = 0; i < body.byteLength; i++) {
    if (body[i] === 0) zeros += 1;
  }
  const out = new Uint8Array(1 + body.byteLength + zeros + 2);
  out[0] = TAG_STR;
  let o = 1;
  for (let i = 0; i < body.byteLength; i++) {
    const b = body[i]!;
    if (b === 0) {
      out[o++] = 0;
      out[o++] = 0xff;
    } else {
      out[o++] = b;
    }
  }
  out[o++] = 0;
  out[o] = 0;
  return out;
}

export function encodeTyped(value: IndexValue): Uint8Array {
  if (value === null) return new Uint8Array([TAG_NULL]);
  if (value === false) return new Uint8Array([TAG_FALSE]);
  if (value === true) return new Uint8Array([TAG_TRUE]);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("index number must be finite");
    }
    const out = new Uint8Array(1 + 8);
    out[0] = TAG_NUM;
    out.set(encodeOrderFloat64(value), 1);
    return out;
  }
  if (typeof value === "string") {
    const body = encoder.encode(value);
    if (body.byteLength > 0xffff) throw new RangeError("string too long");
    return encodeSortedString(body);
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > 0xffff) throw new RangeError("bytes too long");
    const out = new Uint8Array(1 + 2 + value.byteLength);
    out[0] = TAG_BIN;
    new DataView(out.buffer).setUint16(1, value.byteLength, true);
    out.set(value, 3);
    return out;
  }
  const _exhaustive: never = value;
  throw new TypeError(`unsupported index value: ${String(_exhaustive)}`);
}

export function skipTyped(buf: Uint8Array, offset: number): number {
  const tag = buf[offset];
  if (tag === undefined) throw new RangeError("truncated typed value");
  if (tag === TAG_NULL || tag === TAG_FALSE || tag === TAG_TRUE) return offset + 1;
  if (tag === TAG_NUM) {
    if (offset + 9 > buf.byteLength) throw new RangeError("truncated number");
    return offset + 9;
  }
  if (tag === TAG_STR) {
    let i = offset + 1;
    while (i + 1 < buf.byteLength) {
      const b = buf[i];
      if (b !== 0) {
        i += 1;
        continue;
      }
      const next = buf[i + 1];
      if (next === 0) return i + 2;
      if (next === 0xff) {
        i += 2;
        continue;
      }
      throw new RangeError("bad string escape");
    }
    throw new RangeError("truncated string");
  }
  if (tag === TAG_BIN) {
    if (offset + 3 > buf.byteLength) throw new RangeError("truncated len");
    const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(
      offset + 1,
      true,
    );
    const next = offset + 3 + len;
    if (next > buf.byteLength) throw new RangeError("truncated payload");
    return next;
  }
  throw new RangeError(`unknown typed tag 0x${tag.toString(16)}`);
}

export function encodeCompound(values: readonly IndexValue[]): Uint8Array {
  const parts = values.map(encodeTyped);
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function normalizeIndexValues(
  value: IndexValue | readonly IndexValue[],
): IndexValue[] {
  return Array.isArray(value) ? [...value] : [value as IndexValue];
}
