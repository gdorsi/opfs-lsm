import type { KeyBounds } from "./db.js";
import { CorruptDatabaseError } from "./errors.js";

export type TupleValue = null | boolean | number | string;

/** `KeyBounds` with an upper bound, which `tupleBounds` and `stringPrefixBounds` always set. */
export type TupleBounds = Required<KeyBounds>;

const TAG = { null: 0x01, false: 0x02, true: 0x03, number: 0x04, string: 0x05 } as const;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const f64 = new DataView(new ArrayBuffer(8));

// One buffer for every key under construction. A key is built synchronously
// from the first write to `take`, so nothing else can interleave.
let buf = new Uint8Array(256);
let len = 0;

function room(n: number): void {
  if (len + n <= buf.length) return;
  const next = new Uint8Array(Math.max(buf.length * 2, len + n));
  next.set(buf.subarray(0, len));
  buf = next;
}

function write(bytes: Uint8Array): void {
  room(bytes.length);
  buf.set(bytes, len);
  len += bytes.length;
}

/** Encodes straight into `buf` (a UTF-16 unit is at most 3 UTF-8 bytes), then makes room for the escapes, which are rare. */
function writeEscaped(s: string): void {
  if (!s.isWellFormed()) throw new RangeError("a tuple string must not hold a lone surrogate");
  room(s.length * 3);
  const start = len;
  len += utf8.encodeInto(s, buf.subarray(len)).written;
  let zeros = 0;
  for (let i = start; i < len; i++) if (buf[i] === 0) zeros++;
  if (zeros === 0) return;
  room(zeros);
  let w = len + zeros;
  for (let r = len - 1; r >= start; r--) {
    const b = buf[r]!;
    if (b === 0) buf[--w] = 0xff;
    buf[--w] = b;
  }
  len += zeros;
}

function writeValue(v: TupleValue): void {
  room(9);
  if (v === null) buf[len++] = TAG.null;
  else if (v === false) buf[len++] = TAG.false;
  else if (v === true) buf[len++] = TAG.true;
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("a tuple number must be finite");
    buf[len++] = TAG.number;
    f64.setFloat64(0, v === 0 ? 0 : v);
    const negative = f64.getUint8(0) >= 0x80;
    for (let i = 0; i < 8; i++) {
      const b = f64.getUint8(i);
      buf[len++] = negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b;
    }
  } else if (typeof v === "string") {
    buf[len++] = TAG.string;
    writeEscaped(v);
    room(1);
    buf[len++] = 0x00;
  } else {
    throw new TypeError("a tuple value must be null, a boolean, a number or a string");
  }
}

function take(): Uint8Array {
  return buf.slice(0, len);
}

/**
 * `prefix ++ enc(v1) ++ .. ++ enc(vn) ++ tail`. Throws a TypeError for a value
 * of another type, and a RangeError for a lone surrogate, a number that is not
 * finite, or a `tail` that starts with FF.
 */
export function encodeTuple(values: readonly TupleValue[], prefix?: Uint8Array, tail?: Uint8Array): Uint8Array {
  if (tail !== undefined && tail[0] === 0xff) throw new RangeError("a tuple tail must not start with byte FF");
  len = 0;
  if (prefix) write(prefix);
  for (const v of values) writeValue(v);
  if (tail) write(tail);
  return take();
}

/** Every key whose field after `prefix` is a string that starts with `s`. */
export function stringPrefixBounds(prefix: Uint8Array, s: string): TupleBounds {
  len = 0;
  write(prefix);
  room(1);
  buf[len++] = TAG.string;
  writeEscaped(s);
  return tupleBounds(take());
}

/**
 * Every key that continues `prefix` where a field ends: `prefix` itself, a
 * longer tuple, or a tail of raw UTF-8. After a complete field the next byte is
 * a tag (01..05), a UTF-8 byte or nothing, never FF, so `prefix ++ FF` is
 * above all of them. `prefixBound` also takes the strings that continue
 * `prefix` with U+0000, which encode as 00 FF.
 */
export function tupleBounds(prefix: Uint8Array): TupleBounds {
  const endExclusive = new Uint8Array(prefix.length + 1);
  endExclusive.set(prefix);
  endExclusive[prefix.length] = 0xff;
  return { start: prefix, endExclusive };
}

function corrupt(at: number): never {
  throw new CorruptDatabaseError(`key has no tuple field at byte ${at}`);
}

function fieldEnd(key: Uint8Array, at: number): number {
  switch (key[at]) {
    case TAG.null:
    case TAG.false:
    case TAG.true:
      return at + 1;
    case TAG.number:
      if (at + 9 <= key.length) return at + 9;
      break;
    case TAG.string:
      for (let i = at + 1; i < key.length; i++) {
        if (key[i] !== 0x00) continue;
        if (key[i + 1] !== 0xff) return i + 1;
        i++;
      }
      break;
  }
  return corrupt(at);
}

/** Where `count` fields from `from` end, without decoding them. */
export function skipTuple(key: Uint8Array, count: number, from = 0): number {
  let at = from;
  for (let i = 0; i < count; i++) at = fieldEnd(key, at);
  return at;
}

function valueAt(key: Uint8Array, at: number, end: number): TupleValue {
  switch (key[at]) {
    case TAG.null:
      return null;
    case TAG.false:
      return false;
    case TAG.true:
      return true;
    case TAG.number: {
      const negative = key[at + 1]! < 0x80;
      for (let i = 0; i < 8; i++) {
        const b = key[at + 1 + i]!;
        f64.setUint8(i, negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b);
      }
      return f64.getFloat64(0);
    }
    default: {
      const body = key.subarray(at + 1, end - 1);
      if (!body.includes(0)) return fromUtf8.decode(body);
      const out = new Uint8Array(body.length);
      let n = 0;
      for (let i = 0; i < body.length; i++) {
        out[n++] = body[i]!;
        if (body[i] === 0) i++;
      }
      return fromUtf8.decode(out.subarray(0, n));
    }
  }
}

/**
 * Decodes `count` fields starting at byte `from`, or every field up to the
 * end of `key` when `count` is not given. `end` is where the last field
 * stops, so a tail is `key.subarray(end)`. A tail can start with any byte
 * but FF, a tag included, so a key with a tail needs its `count`.
 */
export function decodeTuple(key: Uint8Array, count?: number, from = 0): { values: TupleValue[]; end: number } {
  const values: TupleValue[] = [];
  let at = from;
  while (count === undefined ? at < key.length : values.length < count) {
    const end = fieldEnd(key, at);
    values.push(valueAt(key, at, end));
    at = end;
  }
  return { values, end: at };
}
