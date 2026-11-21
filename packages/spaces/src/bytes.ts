/** Byte helpers shared by every module. No dependencies. */

import { SpacesError } from "./errors.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const EMPTY = new Uint8Array(0);

export const utf8 = (text: string): Uint8Array => enc.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => dec.decode(bytes);

export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

export function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

export const readU32 = (bytes: Uint8Array, at: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);

/** Integers below 2^53 as u64 big-endian. */
export function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

export const readU64 = (bytes: Uint8Array, at: number): number =>
  Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at));

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** RFC 4648 base64url, no padding. */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** Inverse of `toBase64url`. Returns undefined on any character outside the alphabet or an impossible length. */
export function fromBase64url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) return undefined;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Append-only binary writer: u8, u32 and u64 big-endian, fixed and u32-length byte strings. */
export class Writer {
  private buf: Uint8Array<ArrayBuffer>;
  private view: DataView;
  private len = 0;

  constructor(hint = 256) {
    this.buf = new Uint8Array(hint);
    this.view = new DataView(this.buf.buffer);
  }

  /** Reserves `n` bytes and returns their offset. Read `buf` and `view` after it: it may replace both. */
  private room(n: number): number {
    const at = this.len;
    const need = at + n;
    if (need > this.buf.length) {
      const next = new Uint8Array(Math.max(need, this.buf.length * 2));
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.len = need;
    return at;
  }

  u8(n: number): this {
    const at = this.room(1);
    this.view.setUint8(at, n);
    return this;
  }
  u32(n: number): this {
    const at = this.room(4);
    this.view.setUint32(at, n);
    return this;
  }
  /** Integers below 2^53. */
  u64(n: number): this {
    const at = this.room(8);
    this.view.setBigUint64(at, BigInt(n));
    return this;
  }
  /** Exactly `size` bytes, no length prefix. Throws on any other length, so a format never has two encodings. */
  fixed(bytes: Uint8Array, size: number): this {
    if (bytes.length !== size) throw new RangeError(`expected ${size} bytes, got ${bytes.length}`);
    const at = this.room(size);
    this.buf.set(bytes, at);
    return this;
  }
  /** u32 length, then the bytes. */
  bytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).raw(bytes);
  }
  /** Bytes without a prefix. */
  raw(bytes: Uint8Array): this {
    const at = this.room(bytes.length);
    this.buf.set(bytes, at);
    return this;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/**
 * The reader for `Writer`'s formats. Every read checks the remaining length
 * first, so it never reads past the end. A failure throws SpacesError with
 * `code`.
 */
export class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly code: "protocol" = "protocol",
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fail(message: string): never {
    throw new SpacesError(this.code, message);
  }

  private take(n: number): number {
    if (n > this.bytes.length - this.at) this.fail("truncated input");
    const at = this.at;
    this.at += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  u32(): number {
    return this.view.getUint32(this.take(4));
  }
  u64(): number {
    const n = this.view.getBigUint64(this.take(8));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) this.fail("integer above 2^53");
    return Number(n);
  }
  fixed(size: number): Uint8Array {
    const at = this.take(size);
    return this.bytes.slice(at, at + size);
  }
  bytesField(): Uint8Array {
    return this.fixed(this.u32());
  }
  /** A list count, refused if the remaining bytes cannot hold that many items of `minSize` bytes. */
  count(minSize: number): number {
    const n = this.u32();
    if (n * minSize > this.bytes.length - this.at) this.fail("list longer than the input");
    return n;
  }
  list<T>(minSize: number, item: () => T): T[] {
    const n = this.count(minSize);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item());
    return out;
  }
  /** Throws unless every byte was consumed. */
  end(): void {
    if (this.at !== this.bytes.length) this.fail("trailing bytes");
  }
}

/** The bytes as a string of code units, for Map and Set keys. */
export function keyString(bytes: Uint8Array): string {
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
}

/** The smallest key above every key that starts with `prefix`, or undefined when there is none (all 0xFF). */
export function successor(prefix: Uint8Array): Uint8Array | undefined {
  let n = prefix.length;
  while (n > 0 && prefix[n - 1] === 0xff) n--;
  if (n === 0) return undefined;
  const out = prefix.slice(0, n);
  out[n - 1]! += 1;
  return out;
}

/** `[prefix, successor(prefix))`: every key that starts with `prefix`. */
export function prefixBounds(prefix: Uint8Array): { readonly start: Uint8Array; readonly endExclusive?: Uint8Array } {
  const end = successor(prefix);
  return end === undefined ? { start: prefix } : { start: prefix, endExclusive: end };
}

/** The smallest key after `key`. */
export const after = (key: Uint8Array): Uint8Array => concat(key, Uint8Array.of(0));
