/*
 * The byte layout. Every key the package writes or scans is built here.
 *
 *     catalog   64 00 00                      -> catalog JSON
 *     row       64 CC CC 00 <id>              -> document JSON
 *     sorted    64 CC CC II <v1>..<vn> <id>   -> empty
 *     covering  64 CC CC II <v1>..<vn> <id>   -> {"f1":..,"fk":..} (UTF-8 JSON)
 *     unique    64 CC CC II <v1>..<vn>        -> <id>
 *     text      64 CC CC II <v1>..<vn> <id>   -> "w1 w2 ..." (lowercased words)
 *
 * CC CC is a collection id (u16be, 1..65535) and II an index id (1..255);
 * index id 00 is the rows. <id> is raw UTF-8. A value <v> is one field of
 * the tuple encoding of `@opfs-lsm/kv/tuple`, which also owns the bounds of
 * every key that continues a prefix, an id included. A covering entry is a
 * sorted entry of an index that declares `include`: its value holds, in
 * declared order, each included field its document has.
 */
import type { Range } from "@opfs-lsm/kv";
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

/** Up to this many UTF-16 units `utf8Bytes` encodes into `scratch`. */
const SCRATCH_UNITS = 1024;
const scratch = new Uint8Array(SCRATCH_UNITS * 3);

/**
 * The same bytes as `utf8.encode`. `encode` allocates its result in the
 * browser, which costs several times more than encoding a short string, so a
 * string that fits is encoded into `scratch` and copied out.
 */
function utf8Bytes(s: string): Uint8Array {
  if (s.length > SCRATCH_UNITS) return utf8.encode(s);
  return scratch.slice(0, utf8.encodeInto(s, scratch).written);
}

export function idBytes(id: DocId): Uint8Array {
  return utf8Bytes(id);
}

/** The id whose UTF-8 is `bytes` from `from` on. */
export function idOf(bytes: Uint8Array, from = 0): string {
  return asciiAt(bytes, from, bytes.length) ?? fromUtf8.decode(from ? bytes.subarray(from) : bytes);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The smallest key after `key`. */
export function after(key: Uint8Array): Uint8Array {
  return concat(key, ZERO);
}
const ZERO = Uint8Array.of(0);

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

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
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
  return utf8Bytes(wordsOf(text).join(" "));
}

/** kv keeps an entry iff its value contains every pattern: every typed word occurs inside a word of the text. */
function matchPatterns(match: string): Uint8Array[] {
  const words = wordsOf(match);
  if (words.length === 0) badQuery("match has no words");
  return words.map((w) => utf8.encode(w));
}

export type ScanTarget =
  | { readonly kind: "rows"; readonly prefix: Uint8Array }
  | {
      readonly kind: "sorted" | "unique" | "text" | "covering";
      readonly prefix: Uint8Array;
      readonly rowPrefix: Uint8Array;
      readonly arity: number;
    };

/**
 * The one bound builder. `eq` fixes the first k components and one bound
 * applies to component k + 1. `limit` is not set here.
 */
export function scanPlan(target: ScanTarget, q: QueryInput): Range {
  const { gt, gte, lt, lte, startsWith } = q;
  if (gt !== undefined && gte !== undefined) badQuery("gt and gte together");
  if (lt !== undefined && lte !== undefined) badQuery("lt and lte together");
  const bounded = gt !== undefined || gte !== undefined || lt !== undefined || lte !== undefined;
  if (startsWith !== undefined && (bounded || typeof startsWith !== "string" || !startsWith.isWellFormed())) {
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
  return {
    start: lower,
    endExclusive: upper,
    ...(reverse ? { reverse } : {}),
    ...(q.match !== undefined ? { valueContains: matchPatterns(q.match) } : {}),
  };
}

function indexBounds(prefix: Uint8Array, q: QueryInput, eq: readonly unknown[]): [Uint8Array, Uint8Array] {
  const p = encodeTuple(eq.map(checkQueryValue), prefix);
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
    typeof v === "string" && v.isWellFormed() ? concat(prefix, utf8.encode(v)) : badQuery("an id bound must be a well-formed string");
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

/** Where the id starts in an entry's key. A unique entry's id is its value. */
function idStart(target: ScanTarget, key: Uint8Array): number {
  return target.kind === "rows" ? target.prefix.length : skipTuple(key, target.arity, target.prefix.length);
}

export function entryId(target: ScanTarget, key: Uint8Array, value: Uint8Array): Uint8Array {
  return target.kind === "unique" ? value : key.subarray(idStart(target, key));
}

/** `idOf(entryId(...))` without the subarray. */
export function entryIdString(target: ScanTarget, key: Uint8Array, value: Uint8Array): string {
  return target.kind === "unique" ? idOf(value) : idOf(key, idStart(target, key));
}

/** `value` is what `queryEntries` decoded of the entry's value: the id of a unique entry, the fields of a covering one. */
export function decodeEntries(
  target: ScanTarget,
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
