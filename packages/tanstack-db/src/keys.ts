export type CollectionPrefix = Uint8Array & { readonly __brand: "CollectionPrefix" };

export type RowKey = string | number;

/** Row to bytes and back. The default, `jsonCodec`, drops what JSON drops: Date, Map, undefined fields. */
export interface RowCodec<T> {
  encode(row: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

const COLLECTION = 0x74;
const NUMBER = 0x01;
const STRING = 0x02;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** TextEncoder maps a lone surrogate to U+FFFD, so two strings would share one encoding. */
function utf8(text: string, what: string): Uint8Array {
  if (!text.isWellFormed()) throw new TypeError(`${what} has a lone surrogate`);
  return encoder.encode(text);
}

export function collectionPrefix(name: string): CollectionPrefix {
  const bytes = utf8(name, "collection name");
  if (bytes.length > 0xffff) throw new RangeError("collection name is longer than 65535 UTF-8 bytes");
  const out = new Uint8Array(3 + bytes.length);
  out[0] = COLLECTION;
  out[1] = bytes.length >>> 8;
  out[2] = bytes.length & 0xff;
  out.set(bytes, 3);
  return out as CollectionPrefix;
}

export function encodeRowKey(prefix: CollectionPrefix, key: RowKey): Uint8Array {
  if (typeof key === "string") {
    const bytes = utf8(key, "row key");
    const out = new Uint8Array(prefix.length + 1 + bytes.length);
    out.set(prefix);
    out[prefix.length] = STRING;
    out.set(bytes, prefix.length + 1);
    return out;
  }
  if (typeof key !== "number") throw new TypeError(`row key must be a string or a number, got ${typeof key}`);
  const out = new Uint8Array(prefix.length + 9);
  out.set(prefix);
  out[prefix.length] = NUMBER;
  const view = new DataView(out.buffer, prefix.length + 1, 8);
  if (Number.isNaN(key)) view.setUint32(0, 0x7ff80000);
  else view.setFloat64(0, key === 0 ? 0 : key);
  const negative = view.getUint32(0) >>> 31 === 1;
  view.setUint32(0, negative ? ~view.getUint32(0) : view.getUint32(0) ^ 0x80000000);
  if (negative) view.setUint32(4, ~view.getUint32(4));
  return out;
}

export function decodeRowKey(prefix: CollectionPrefix, bytes: Uint8Array): RowKey {
  if (!hasPrefix(prefix, bytes)) throw new TypeError("key is not in this collection");
  const body = bytes.subarray(prefix.length + 1);
  switch (bytes[prefix.length]) {
    case STRING:
      return decoder.decode(body);
    case NUMBER: {
      if (body.length !== 8) throw new TypeError("number key is not 8 bytes");
      const view = new DataView(new ArrayBuffer(8));
      const hi = (body[0]! << 24) | (body[1]! << 16) | (body[2]! << 8) | body[3]!;
      const lo = (body[4]! << 24) | (body[5]! << 16) | (body[6]! << 8) | body[7]!;
      const negative = hi >>> 31 === 0;
      view.setUint32(0, negative ? ~hi : hi ^ 0x80000000);
      view.setUint32(4, negative ? ~lo : lo);
      return view.getFloat64(0);
    }
    default:
      throw new TypeError("key has an unknown tag");
  }
}

export function hasPrefix(prefix: CollectionPrefix, key: Uint8Array): boolean {
  if (key.length <= prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

export function jsonCodec<T>(): RowCodec<T> {
  return {
    encode: (row) => encoder.encode(JSON.stringify(row)),
    decode: (bytes) => JSON.parse(decoder.decode(bytes)) as T,
  };
}
