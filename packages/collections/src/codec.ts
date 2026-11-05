import {
  encodeCompound,
  normalizeIndexValues,
  skipTyped,
  type IndexValue,
} from "./typed.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode a string as u16le length + UTF-8 (primary / trailing id segment). */
export function encodeString(s: string): Uint8Array {
  const body = enc.encode(s);
  if (body.byteLength > 0xffff) {
    throw new RangeError("string too long for key segment");
  }
  const out = new Uint8Array(2 + body.byteLength);
  new DataView(out.buffer).setUint16(0, body.byteLength, true);
  out.set(body, 2);
  return out;
}

export function decodeString(
  buf: Uint8Array,
  offset = 0,
): { value: string; next: number } {
  if (offset + 2 > buf.byteLength) throw new RangeError("truncated key");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint16(offset, true);
  const start = offset + 2;
  if (start + len > buf.byteLength) throw new RangeError("truncated key");
  const value = dec.decode(buf.subarray(start, start + len));
  return { value, next: start + len };
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

const T_PREFIX = enc.encode("t/");
const I_PREFIX = enc.encode("i/");

/** Prefix shared by every primary key in `table` (no id segment). */
export function tablePrefix(table: string): Uint8Array {
  return concatBytes(T_PREFIX, encodeString(table));
}

/** Primary key: t/ + table + id (length-prefixed segments). */
export function primaryKey(table: string, id: string): Uint8Array {
  return concatBytes(tablePrefix(table), encodeString(id));
}

function encodeIndexValuePart(
  value: IndexValue | readonly IndexValue[],
): Uint8Array {
  return encodeCompound(normalizeIndexValues(value));
}

/** Index key: i/ + table + index + typed value(s) + id. */
export function indexKey(
  table: string,
  index: string,
  value: IndexValue | readonly IndexValue[],
  id: string,
): Uint8Array {
  return concatBytes(
    I_PREFIX,
    encodeString(table),
    encodeString(index),
    encodeIndexValuePart(value),
    encodeString(id),
  );
}

/** Prefix for equality / compound-prefix scan (excludes id). */
export function indexPrefix(
  table: string,
  index: string,
  value?: IndexValue | readonly IndexValue[],
): Uint8Array {
  if (value === undefined) {
    return concatBytes(I_PREFIX, encodeString(table), encodeString(index));
  }
  return concatBytes(
    I_PREFIX,
    encodeString(table),
    encodeString(index),
    encodeIndexValuePart(value),
  );
}

/**
 * Decode the trailing primary id from an index key.
 * `arity` = number of typed components in the index value.
 */
export function extractIndexRowId(
  key: Uint8Array,
  arity: number,
): string | undefined {
  try {
    let o = 2; // skip i/
    o = decodeString(key, o).next; // table
    o = decodeString(key, o).next; // index name
    for (let i = 0; i < arity; i++) o = skipTyped(key, o);
    return decodeString(key, o).value;
  } catch {
    return undefined;
  }
}

export function encodeJson(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(dec.decode(bytes)) as T;
}

export type { IndexValue };
