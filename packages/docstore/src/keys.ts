/*
 * The byte layout. Every key the package writes or scans is built here.
 *
 *     catalog   64 00 00                      -> catalog JSON
 *     row       64 CC CC 00 <id>              -> document JSON
 *     sorted    64 CC CC II <v1>..<vn> <id>   -> empty
 *     covering  64 CC CC II <v1>..<vn> <id>   -> {"f1":..,"fk":..} (UTF-8 JSON)
 *     unique    64 CC CC II <v1>..<vn>        -> <id>
 *     text      64 CC CC II <v1>..<vn> <id>   -> "w1 w2 ..." (lowercased words)
 *     count     64 CC CC II <v1>..<vn>        -> float64 BE: documents the group gained since the index was added
 *     base      64 CC CC II <v1>..<vn> 00     -> float64 BE: documents in the group when the index was added
 *
 * CC CC is a collection id (u16be, 1..65535) and II an index id (1..255);
 * index id 00 is the rows. <id> is raw UTF-8. A value <v> is one field of
 * the tuple encoding of `@opfs-lsm/kv/tuple`, which also owns the bounds of
 * every key that continues a prefix, an id included. A covering entry is a
 * sorted entry of an index that declares `include`: its value holds each
 * included field its document has. A group of a count index is one value
 * tuple of its fields, and its count is the sum of its two rows, an absent
 * row being 0. No field starts with 00, so every bound holds both rows of a
 * group or neither.
 */
import { CorruptDatabaseError, type Range } from "@opfs-lsm/kv";
import { asciiAt, decodeTuple, encodeTuple, skipTuple, stringPrefixBounds, tupleBounds } from "@opfs-lsm/kv/tuple";
import { DocStoreError } from "./errors.js";
import type { Cursor, QueryInput, Scalar } from "./schema.js";

export const ROOT = 0x64;
export const CATALOG_KEY: Uint8Array = Uint8Array.of(ROOT, 0x00, 0x00);
const ROWS = 0x00;
/** kv's key limit. */
export const MAX_KEY_BYTES = 8 * 1024;
const MAX_ID_BYTES = 1024;

/** 1..65535, allocated from the catalog, never reused. */
export type CollectionId = number & { readonly __brand: "CollectionId" };
/** 1..255 within a collection, allocated from the catalog, never reused. */
export type IndexId = number & { readonly __brand: "IndexId" };
/** A non-empty, well-formed string of at most 1,024 UTF-8 bytes. */
export type DocId = string & { readonly __brand: "DocId" };

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Every string in a key must be well formed: TextEncoder writes each lone surrogate as U+FFFD, so two strings holding one could share a key. */
export function parseId(id: unknown): DocId {
  if (typeof id !== "string" || id === "") {
    throw new DocStoreError("document", "a document id must be a non-empty string");
  }
  if (!id.isWellFormed()) {
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

/** Up to this many UTF-16 units `idBytes` encodes into `scratch`. */
const SCRATCH_UNITS = 1024;
const scratch = new Uint8Array(SCRATCH_UNITS * 3);

/** Past this many UTF-16 units `encodeInto` beats the loop in `idBytes`. */
const ASCII_LOOP_MAX = 64;

/**
 * The same bytes as `utf8.encode`. A short ASCII string, nearly every id and
 * query word, is copied unit by unit, which beats the call into TextEncoder.
 * `encode` allocates its result in the browser, which costs several times
 * more than encoding a short string, so any other string that fits is
 * encoded into `scratch` and copied out.
 */
export function idBytes(s: string): Uint8Array {
  const n = s.length;
  if (n <= ASCII_LOOP_MAX) {
    let i = 0;
    while (i < n && s.charCodeAt(i) < 0x80) i++;
    if (i === n) {
      const out = new Uint8Array(n);
      for (i = 0; i < n; i++) out[i] = s.charCodeAt(i);
      return out;
    }
  }
  if (n > SCRATCH_UNITS) return utf8.encode(s);
  return scratch.slice(0, utf8.encodeInto(s, scratch).written);
}

/** `concat(prefix, idBytes(id))`, encoded into `scratch` and copied once. */
export function rowKey(prefix: Uint8Array, id: DocId): Uint8Array {
  return id.length > SCRATCH_UNITS ? concat(prefix, utf8.encode(id)) : concat(prefix, scratch, 0, utf8.encodeInto(id, scratch).written);
}

/** The id whose UTF-8 is `bytes` from `from` on. */
export function idOf(bytes: Uint8Array, from = 0): string {
  return asciiAt(bytes, from, bytes.length) ?? fromUtf8.decode(from ? bytes.subarray(from) : bytes);
}

/** `a` then `b[from, to)`, copied byte by byte: the keys are short, and `subarray` costs more than the loop. */
export function concat(a: Uint8Array, b: Uint8Array, from = 0, to = b.length): Uint8Array {
  const out = new Uint8Array(a.length + to - from);
  out.set(a);
  for (let i = a.length; i < out.length; ) out[i++] = b[from++]!;
  return out;
}

/** The smallest key after `key`. */
export function after(key: Uint8Array): Uint8Array {
  return concat(key, ZERO);
}
const ZERO = Uint8Array.of(0);

/**
 * The bound right after `key` and, when `key` is longer than a key can be,
 * after every key it starts with. No stored key passes `MAX_KEY_BYTES` and
 * kv takes no longer bound, so at the limit it is the next key that can exist.
 */
function past(key: Uint8Array): Uint8Array {
  if (key.length < MAX_KEY_BYTES) return after(key);
  const next = key.slice(0, MAX_KEY_BYTES);
  let end = MAX_KEY_BYTES;
  while (next[end - 1] === 0xff) end--;
  next[end - 1]!++;
  return next.subarray(0, end);
}

export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hasPrefix(key: Uint8Array, prefix: Uint8Array): boolean {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

export function keyString(key: Uint8Array): string {
  return String.fromCharCode.apply(null, key as unknown as number[]);
}

/** The order of `a` from `from` and `b` from `to`, as bytes. */
export function compareBytes(a: Uint8Array, b: Uint8Array, from = 0, to = 0): number {
  const n = Math.min(a.length - from, b.length - to);
  for (let i = 0; i < n; i++) {
    const d = a[from + i]! - b[to + i]!;
    if (d !== 0) return d;
  }
  return a.length - from - (b.length - to);
}

function badQuery(message: string): never {
  throw new DocStoreError("query", message);
}

function checkQueryValue(value: unknown): Scalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.isWellFormed()) return value;
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

/** A text entry's value. Words hold no space, so a typed word occurs in it iff it occurs inside one word. */
export function textValue(text: string): Uint8Array {
  return idBytes(wordsOf(text).join(" "));
}

/** kv keeps an entry iff its value contains every pattern: every typed word occurs inside a word of the text. */
function matchPatterns(match: string): Uint8Array[] {
  const words = wordsOf(match);
  if (words.length === 0) badQuery("match has no words");
  return words.map(idBytes);
}

export type ScanTarget =
  | { readonly kind: "rows"; readonly prefix: Uint8Array }
  | {
      readonly kind: "sorted" | "unique" | "text" | "covering";
      readonly prefix: Uint8Array;
      readonly rowPrefix: Uint8Array;
      readonly arity: number;
      /** The first component is an array field: one document holds several entries. */
      readonly multi?: boolean;
    }
  | {
      readonly kind: "count";
      readonly prefix: Uint8Array;
      readonly arity: number;
      /** The first component is an array field: one document is in several groups. */
      readonly multi?: boolean;
    };

/** A target whose keys are entries, which `query` reads. A count index has rows per group and no entry. */
export type EntryTarget = Exclude<ScanTarget, { readonly kind: "count" }>;
export type IndexTarget = Exclude<EntryTarget, { readonly kind: "rows" }>;

/** The most combinations of listed values one query reads. */
const MAX_RANGES = 64;

export type ScanPlan = {
  /** One range per combination of the values `eq` lists, in the order of their prefixes. `skip` is the length of the range's `eq` prefix. */
  readonly ranges: readonly { readonly range: Range; readonly skip: number }[];
  /** One document can hold two combinations: a merge may meet it twice. */
  readonly repeats: boolean;
};

/** A slot's distinct values, as the bytes they encode to, in key order. */
function slotValues(slot: unknown): Uint8Array[] {
  const bytes = (Array.isArray(slot) ? slot : [slot]).map((v) => encodeTuple([checkQueryValue(v)])).sort(compareBytes);
  return bytes.filter((b, i) => i === 0 || !bytesEqual(b, bytes[i - 1]));
}

/**
 * The one planner. `eq` fixes the first k components, each slot to a value or
 * to a list of them, and one bound applies to component k + 1. Each
 * combination of the listed values is one range. `limit` is not set here.
 */
export function scanPlan(target: ScanTarget, q: QueryInput): ScanPlan {
  const { gt, gte, lt, lte, startsWith } = q;
  if (gt !== undefined && gte !== undefined) badQuery("gt and gte together");
  if (lt !== undefined && lte !== undefined) badQuery("lt and lte together");
  const bounded = gt !== undefined || gte !== undefined || lt !== undefined || lte !== undefined;
  if (startsWith !== undefined && (bounded || typeof startsWith !== "string" || !startsWith.isWellFormed())) {
    badQuery("startsWith takes a well-formed string and no other bound");
  }
  const eq = q.eq ?? [];
  const rows = target.kind === "rows";
  const arity = rows ? 1 : target.arity;
  if (!Array.isArray(eq) || eq.length > arity) badQuery(`eq takes at most ${arity} values`);
  if (eq.length === arity && (bounded || startsWith !== undefined)) {
    badQuery("eq fixes every component, so no bound can follow");
  }
  if (q.match !== undefined && target.kind !== "text") badQuery("match needs a text index");
  if (target.kind === "count") {
    if (q.after !== undefined || q.reverse !== undefined || q.offset !== undefined) {
      badQuery("a count index has no order, so no after, reverse or offset");
    }
    // The sum of two of its groups would count a document that holds both values twice.
    if (target.multi && Array.isArray(eq[0])) badQuery("the array field of a count index takes no list in eq");
  }

  const lists = eq.some(Array.isArray);
  // There, two entries equal after `eq` are two documents.
  if (lists && (rows || target.kind === "unique")) badQuery("a unique index and the rows take no list in eq");
  let heads: Uint8Array[];
  let repeats = false;
  if (!lists) heads = [rows ? target.prefix : encodeTuple(eq.map(checkQueryValue), target.prefix)];
  else {
    const slots = eq.map(slotValues);
    if (slots.reduce((n, s) => n * s.length, 1) > MAX_RANGES) badQuery(`eq takes at most ${MAX_RANGES} combinations`);
    heads = slots.reduce((hs, s) => hs.flatMap((h) => s.map((b) => concat(h, b))), [target.prefix]);
    repeats = target.kind !== "rows" && target.multi === true && slots[0]!.length > 1;
  }
  const bounds = heads.map((head) => (rows ? rowBounds(head, q, eq) : indexBounds(head, q)));
  // An empty list reads nothing, and its bound is still checked.
  if (heads.length === 0) indexBounds(target.prefix, q);

  // The cursor is one result: every range resumes after the bytes it holds past its own `eq` prefix.
  let tail: Uint8Array | undefined;
  if (q.after !== undefined) {
    const k = decodeCursor(q.after);
    const at = bounds.findIndex(([lower, upper]) => compareBytes(k, lower) >= 0 && compareBytes(k, upper) < 0);
    if (at < 0) throw new DocStoreError("cursor", "the cursor is outside this query's range");
    tail = k.subarray(heads[at]!.length);
  }
  const reverse = q.reverse === true;
  const valueContains = q.match !== undefined ? matchPatterns(q.match) : undefined;
  const ranges: { range: Range; skip: number }[] = [];
  heads.forEach((head, i) => {
    let [start, endExclusive] = bounds[i]!;
    if (tail) {
      const at = concat(head, tail);
      // `at` can pass a key's length under a longer listed value than the cursor's own.
      if (!reverse) start = past(at);
      else endExclusive = at.length > MAX_KEY_BYTES ? past(at) : at;
    }
    // A range the cursor leaves empty is dropped, unless it is the query's only one.
    if (heads.length > 1 && compareBytes(start, endExclusive) >= 0) return;
    ranges.push({ range: { start, endExclusive, ...(reverse ? { reverse } : {}), ...(valueContains ? { valueContains } : {}) }, skip: head.length });
  });
  return { ranges, repeats };
}

/** `p` is the prefix and the tuple of the components `eq` fixes. */
function indexBounds(p: Uint8Array, q: QueryInput): [Uint8Array, Uint8Array] {
  const at = (v: unknown) => tupleBounds(encodeTuple([checkQueryValue(v)], p));
  if (q.startsWith !== undefined) {
    const { start, endExclusive } = stringPrefixBounds(p, q.startsWith);
    return [start, endExclusive];
  }
  const lower = q.gte !== undefined ? at(q.gte).start : q.gt !== undefined ? at(q.gt).endExclusive : p;
  const upper = q.lte !== undefined ? at(q.lte).endExclusive : q.lt !== undefined ? at(q.lt).start : tupleBounds(p).endExclusive;
  return [lower, upper];
}

/** The id is raw UTF-8 with no terminator, so the keys equal to `x` end at `x ++ 00`. */
function rowBounds(prefix: Uint8Array, q: QueryInput, eq: readonly unknown[]): [Uint8Array, Uint8Array] {
  const at = (v: unknown) =>
    typeof v === "string" && v.isWellFormed() ? concat(prefix, idBytes(v)) : badQuery("an id bound must be a well-formed string");
  if (eq.length === 1) {
    const k = at(eq[0]);
    return [k, after(k)];
  }
  if (q.startsWith !== undefined) {
    const { start, endExclusive } = tupleBounds(at(q.startsWith));
    return [start, endExclusive];
  }
  const lower = q.gte !== undefined ? at(q.gte) : q.gt !== undefined ? after(at(q.gt)) : prefix;
  const upper = q.lte !== undefined ? after(at(q.lte)) : q.lt !== undefined ? at(q.lt) : tupleBounds(prefix).endExclusive;
  return [lower, upper];
}

/** `64 CC CC II`, the prefix of every key of an index. */
const INDEX_PREFIX = 4;

export function isBaseKey(key: Uint8Array, arity: number): boolean {
  return skipTuple(key, arity, INDEX_PREFIX) !== key.length;
}

export function encodeCount(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, n);
  return out;
}

/** An absent row counts 0. */
export function decodeCount(bytes: Uint8Array | undefined): number {
  if (bytes === undefined) return 0;
  if (bytes.length !== 8) throw new CorruptDatabaseError("a docstore count is not 8 bytes");
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0);
}

/** Where the id starts in an entry's key. A unique entry's id is its value. */
function idStart(target: EntryTarget, key: Uint8Array): number {
  return target.kind === "rows" ? target.prefix.length : skipTuple(key, target.arity, target.prefix.length);
}

/** The key of the row an index entry points at. */
export function entryRowKey(target: IndexTarget, key: Uint8Array, value: Uint8Array): Uint8Array {
  return target.kind === "unique" ? concat(target.rowPrefix, value) : concat(target.rowPrefix, key, idStart(target, key));
}

/** The id an entry's key ends in. A unique entry's key holds none. */
export function keyId(target: EntryTarget, key: Uint8Array): string {
  return idOf(key, idStart(target, key));
}

/** `value` is what `queryEntries` decoded of the entry's value: the id of a unique entry, the fields of a covering one. */
export function decodeEntries(
  target: EntryTarget,
  entries: readonly { readonly key: Uint8Array; readonly value: unknown }[],
  eqLength: number,
): { id: string; values: Scalar[]; fields?: unknown }[] {
  if (target.kind === "rows") {
    return entries.map(({ key }) => {
      const id = idOf(key, target.prefix.length);
      return { id, values: [id] };
    });
  }
  if (entries.length === 0) return [];
  const { values: eqValues, end: from } = decodeTuple(entries[0]!.key, eqLength, target.prefix.length);
  return entries.map(({ key, value }) => {
    const { values, end } = decodeTuple(key, target.arity - eqLength, from);
    const id = target.kind === "unique" ? (value as string) : idOf(key, end);
    return target.kind === "covering" ? { id, values: eqValues.concat(values), fields: value } : { id, values: eqValues.concat(values) };
  });
}

/** base64url of the key after the root byte, so it names the collection id and index id it came from. */
export function encodeCursor(key: Uint8Array): Cursor {
  return btoa(keyString(key.subarray(1))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") as Cursor;
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
