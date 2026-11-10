/*
 * The byte layout. Every key the package writes or scans is built here.
 *
 *     catalog   64 00 00                      -> catalog JSON
 *     row       64 CC CC 00 <id>              -> document JSON
 *     sorted    64 CC CC II <v1>..<vn> <id>   -> empty
 *     unique    64 CC CC II <v1>..<vn>        -> <id>
 *     text      64 CC CC II <v1>..<vn> <id>   -> " w1 w2 ..." (lowercased words)
 *
 * CC CC is a collection id (u16be, 1..65535) and II an index id (1..255);
 * index id 00 is the rows. <id> is raw UTF-8. A value <v> is one of
 *
 *     01 null   02 false   03 true
 *     04 + float64 big-endian, -0 as +0; sign bit set: every bit flipped, else the sign bit flipped
 *     05 + UTF-8 with each 00 written 00 FF, then 00
 *
 * Every field is prefix-free, so ids sort by content and need no length.
 * After a complete field the next byte is a tag (01..05), a UTF-8 byte or
 * nothing, never FF: `upperOf` relies on that.
 */
import { CorruptDatabaseError, type Range } from "@opfs-lsm/kv";
import { DocStoreError } from "./errors.js";
import type { Cursor, QueryInput, Scalar } from "./schema.js";

export const ROOT = 0x64;
export const CATALOG_KEY: Uint8Array = Uint8Array.of(ROOT, 0x00, 0x00);
const ROWS = 0x00;
const TAG = { null: 0x01, false: 0x02, true: 0x03, number: 0x04, string: 0x05 } as const;
/** kv's key limit. */
export const MAX_KEY_BYTES = 8 * 1024;
const MAX_ID_BYTES = 1024;

/** 1..65535, allocated from the catalog, never reused. */
export type CollectionId = number & { readonly __brand: "CollectionId" };
/** 1..255 within a collection, allocated from the catalog, never reused. */
export type IndexId = number & { readonly __brand: "IndexId" };
/** A non-empty, well-formed string of at most 1,024 UTF-8 bytes. */
export type DocId = string & { readonly __brand: "DocId" };

const utf8 = new TextEncoder();
const LONE_SURROGATE = /\p{Cs}/u;

/** TextEncoder writes every lone surrogate as U+FFFD, so two strings that hold one could share a key. */
export function wellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

export function parseId(id: unknown): DocId {
  if (typeof id !== "string" || id === "") {
    throw new DocStoreError("document", "a document id must be a non-empty string");
  }
  if (!wellFormed(id)) {
    throw new DocStoreError("document", "a document id must not hold a lone surrogate");
  }
  if (id.length * 3 > MAX_ID_BYTES && utf8.encode(id).length > MAX_ID_BYTES) {
    throw new DocStoreError("document", `a document id must be at most ${MAX_ID_BYTES} UTF-8 bytes`);
  }
  return id as DocId;
}

export function collectionPrefix(collection: CollectionId): Uint8Array {
  return Uint8Array.of(ROOT, collection >> 8, collection & 0xff);
}

export function rowPrefix(collection: CollectionId): Uint8Array {
  return Uint8Array.of(ROOT, collection >> 8, collection & 0xff, ROWS);
}

export function indexPrefix(collection: CollectionId, index: IndexId): Uint8Array {
  return Uint8Array.of(ROOT, collection >> 8, collection & 0xff, index);
}

export function idBytes(id: DocId): Uint8Array {
  return utf8.encode(id);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** `prefix ++ FF`: above every key that continues `prefix` at a field boundary, below a string that continues it with U+0000. */
export function upperOf(prefix: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix);
  out[prefix.length] = 0xff;
  return out;
}

/** The smallest key after `key`. */
export function after(key: Uint8Array): Uint8Array {
  return concat(key, ZERO);
}
const ZERO = Uint8Array.of(0);

export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function keyString(key: Uint8Array): string {
  return String.fromCharCode.apply(null, key as unknown as number[]);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// One buffer for every key under construction. A key is built synchronously
// from the first write to `take`, so nothing else can interleave.
let buf = new Uint8Array(256);
let len = 0;
const f64 = new DataView(new ArrayBuffer(8));

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

function writeEscaped(s: string): void {
  const raw = utf8.encode(s);
  if (raw.indexOf(0) < 0) return write(raw);
  room(raw.length * 2);
  for (const b of raw) {
    buf[len++] = b;
    if (b === 0) buf[len++] = 0xff;
  }
}

function writeScalar(v: Scalar): void {
  room(9);
  if (v === null) buf[len++] = TAG.null;
  else if (v === false) buf[len++] = TAG.false;
  else if (v === true) buf[len++] = TAG.true;
  else if (typeof v === "number") {
    buf[len++] = TAG.number;
    f64.setFloat64(0, v === 0 ? 0 : v);
    const negative = f64.getUint8(0) >= 0x80;
    for (let i = 0; i < 8; i++) {
      const b = f64.getUint8(i);
      buf[len++] = negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b;
    }
  } else {
    buf[len++] = TAG.string;
    writeEscaped(v);
    room(1);
    buf[len++] = 0x00;
  }
}

function take(): Uint8Array {
  return buf.slice(0, len);
}

/** `prefix ++ enc(v1) ++ .. ++ enc(vn) ++ tail`. Values come from `JSON.parse` or `checkQueryValue`. */
export function encodeKey(prefix: Uint8Array, values: readonly Scalar[], tail?: Uint8Array): Uint8Array {
  len = 0;
  write(prefix);
  for (const v of values) writeScalar(v);
  if (tail) write(tail);
  return take();
}

/** `prefix ++ 05 ++ escaped(s)`, unterminated: what every string starting with `s` begins with. */
function encodeStringPrefix(prefix: Uint8Array, s: string): Uint8Array {
  len = 0;
  write(prefix);
  room(1);
  buf[len++] = TAG.string;
  writeEscaped(s);
  return take();
}

function skipValue(key: Uint8Array, at: number): number {
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
  throw new CorruptDatabaseError(`index key has no value at byte ${at}`);
}

function badQuery(message: string): never {
  throw new DocStoreError("query", message);
}

function checkQueryValue(value: unknown): Scalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && wellFormed(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  return badQuery(`${String(value)} is not an index value: use null, a boolean, a finite number or a well-formed string`);
}

const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

function wordsOf(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== "");
}

/** A text entry's value. A space before every word, so `" tok"` occurs iff some word starts with `tok`. */
export function textValue(text: string): Uint8Array {
  return utf8.encode(` ${wordsOf(text).join(" ")}`);
}

/** kv keeps an entry iff its value contains every pattern: every typed word starts a word of the text. */
function matchPatterns(match: string): Uint8Array[] {
  const words = wordsOf(match);
  if (words.length === 0) badQuery("match has no words");
  return words.map((w) => utf8.encode(` ${w}`));
}

export type ScanTarget =
  | { readonly kind: "rows"; readonly prefix: Uint8Array }
  | {
      readonly kind: "sorted" | "unique" | "text";
      readonly prefix: Uint8Array;
      readonly rowPrefix: Uint8Array;
      readonly arity: number;
    };

export type ScanPlan = { readonly range: Range; readonly target: ScanTarget };

/**
 * The one bound builder. `eq` fixes the first k components and one bound
 * applies to component k + 1. `limit` is not set here.
 */
export function scanPlan(target: ScanTarget, q: QueryInput): ScanPlan {
  const { gt, gte, lt, lte, startsWith } = q;
  if (gt !== undefined && gte !== undefined) badQuery("gt and gte together");
  if (lt !== undefined && lte !== undefined) badQuery("lt and lte together");
  const bounded = gt !== undefined || gte !== undefined || lt !== undefined || lte !== undefined;
  if (startsWith !== undefined && (bounded || typeof startsWith !== "string" || !wellFormed(startsWith))) {
    badQuery("startsWith takes a well-formed string and no other bound");
  }
  const eq = q.eq ?? [];
  const arity = target.kind === "rows" ? 1 : target.arity;
  if (!Array.isArray(eq) || eq.length > arity) badQuery(`eq takes at most ${arity} values`);
  if (eq.length === arity && (bounded || startsWith !== undefined)) {
    badQuery("eq fixes every component, so no bound can follow");
  }
  if (q.match !== undefined && target.kind !== "text") badQuery("match needs a text index");

  let [lower, upper] = target.kind === "rows" ? rowBounds(target.prefix, q, eq) : indexBounds(target.prefix, q, eq);
  const reverse = q.reverse === true;
  if (q.after !== undefined) {
    const k = decodeCursor(q.after);
    if (compareBytes(k, lower) < 0 || compareBytes(k, upper) >= 0) {
      throw new DocStoreError("cursor", "the cursor is outside this query's range");
    }
    if (reverse) upper = k;
    else lower = after(k);
  }
  const range: Range = {
    start: lower,
    endExclusive: upper,
    ...(reverse ? { reverse } : {}),
    ...(q.match !== undefined ? { valueContains: matchPatterns(q.match) } : {}),
  };
  return { range, target };
}

function indexBounds(prefix: Uint8Array, q: QueryInput, eq: readonly unknown[]): [Uint8Array, Uint8Array] {
  const p = encodeKey(prefix, eq.map(checkQueryValue));
  const at = (v: unknown) => encodeKey(p, [checkQueryValue(v)]);
  if (q.startsWith !== undefined) {
    const lower = encodeStringPrefix(p, q.startsWith);
    return [lower, upperOf(lower)];
  }
  const lower = q.gte !== undefined ? at(q.gte) : q.gt !== undefined ? upperOf(at(q.gt)) : p;
  const upper = q.lte !== undefined ? upperOf(at(q.lte)) : q.lt !== undefined ? at(q.lt) : upperOf(p);
  return [lower, upper];
}

/** The id is raw UTF-8 with no terminator, so the keys equal to `x` end at `x ++ 00`. */
function rowBounds(prefix: Uint8Array, q: QueryInput, eq: readonly unknown[]): [Uint8Array, Uint8Array] {
  const at = (v: unknown) =>
    typeof v === "string" && wellFormed(v) ? concat(prefix, utf8.encode(v)) : badQuery("an id bound must be a well-formed string");
  if (eq.length === 1) {
    const k = at(eq[0]);
    return [k, after(k)];
  }
  if (q.startsWith !== undefined) {
    const lower = at(q.startsWith);
    return [lower, upperOf(lower)];
  }
  const lower = q.gte !== undefined ? at(q.gte) : q.gt !== undefined ? after(at(q.gt)) : prefix;
  const upper = q.lte !== undefined ? after(at(q.lte)) : q.lt !== undefined ? at(q.lt) : upperOf(prefix);
  return [lower, upper];
}

export function entryId(target: ScanTarget, key: Uint8Array, value: Uint8Array): Uint8Array {
  switch (target.kind) {
    case "rows":
      return key.subarray(target.prefix.length);
    case "unique":
      return value;
    case "sorted":
    case "text": {
      let at = target.prefix.length;
      for (let i = 0; i < target.arity; i++) at = skipValue(key, at);
      return key.subarray(at);
    }
  }
}

/** base64url of the key after the root byte, so it names the collection id and index id it came from. */
export function encodeCursor(key: Uint8Array): Cursor {
  let s = "";
  for (let i = 1; i < key.length; i++) s += String.fromCharCode(key[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") as Cursor;
}

function decodeCursor(cursor: Cursor): Uint8Array {
  let s: string;
  try {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]*$/.test(cursor)) throw new Error();
    s = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new DocStoreError("cursor", "not a cursor");
  }
  const key = new Uint8Array(s.length + 1);
  key[0] = ROOT;
  for (let i = 0; i < s.length; i++) key[i + 1] = s.charCodeAt(i);
  return key;
}
