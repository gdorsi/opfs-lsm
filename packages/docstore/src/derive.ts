import { CorruptDatabaseError, type Entry } from "@opfs-lsm/kv";
import type { BoundCollection, IndexPlan, Path } from "./catalog.js";
import { DocStoreError } from "./errors.js";
import { MAX_KEY_BYTES, bytesEqual, encodeKey, keyString, parseId, textValue, wellFormed, type DocId } from "./keys.js";
import type { JsonDoc, Scalar } from "./schema.js";

declare const storedBrand: unique symbol;

/**
 * A document parsed from the JSON text that is, or is about to be, stored.
 * Entries are derived only from this, never from the caller's object, so
 * `-0`, NaN, `undefined`, `toJSON` and class instances have already gone
 * through JSON.
 */
export type StoredDoc = JsonDoc & { readonly [storedBrand]: true };

export type EncodedDoc = {
  readonly id: DocId;
  readonly bytes: Uint8Array;
  readonly doc: StoredDoc;
};

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Parsing the text, not the bytes, skips a decode. The two agree because `JSON.stringify` escapes lone surrogates. */
export function encodeDoc(doc: JsonDoc): EncodedDoc {
  const text = JSON.stringify(doc) as string | undefined;
  const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
  if (text === undefined || !isObject(parsed)) throw new DocStoreError("document", "a document must be a JSON object");
  return { id: parseId(parsed["id"]), bytes: utf8.encode(text), doc: parsed as StoredDoc };
}

export function decodeDoc(bytes: Uint8Array): StoredDoc {
  const parsed: unknown = JSON.parse(fromUtf8.decode(bytes));
  if (!isObject(parsed)) throw new CorruptDatabaseError("a stored document is not a JSON object");
  return parsed as StoredDoc;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why `v` cannot be one value of a key, or undefined if it can. Numbers from `JSON.parse` are finite. */
function unindexable(v: unknown): Unindexable["why"] | undefined {
  if (v === null || typeof v === "boolean" || typeof v === "number") return undefined;
  if (typeof v === "string") return wellFormed(v) ? undefined : "lone-surrogate";
  return "not-scalar";
}

const MAX_ENTRIES_PER_INDEX = 1_000;

/** Why one document cannot be in one index. A missing path is not here: it means "not in this index". */
export type Unindexable = {
  readonly path: string;
  readonly why: "not-scalar" | "lone-surrogate" | "text-not-string" | "key-too-long" | "too-many-entries";
};

const NONE: Entry[] = [];

/**
 * Every entry of `doc` in every maintained index; `id` is the id's UTF-8.
 * On the "next" side, the document about to be written, a value an index
 * cannot hold throws, so nothing is stored. On the "stored" side it gives no
 * entries: such a row predates a still-building index and never had any.
 * The entries of unique indexes are also pushed to `unique`.
 */
export function entriesOf(
  coll: BoundCollection,
  id: Uint8Array,
  doc: StoredDoc,
  side: "next" | "stored",
  unique?: Entry[],
): Entry[] {
  const out: Entry[] = [];
  for (const plan of coll.maintained) {
    const entries = indexEntries(plan, id, doc);
    if (Array.isArray(entries)) {
      for (const e of entries) out.push(e);
      if (unique && plan.target.kind === "unique") for (const e of entries) unique.push(e);
    } else if (side === "next") {
      throw new DocStoreError(
        "document",
        `index "${plan.name}" of "${coll.name}" cannot hold the value at "${entries.path}" (${entries.why})`,
      );
    }
  }
  return out;
}

export function indexEntries(plan: IndexPlan, id: Uint8Array, doc: StoredDoc): Entry[] | Unindexable {
  const { spec } = plan;
  const multi = spec.kind === "sorted" && spec.multi;
  const values: Scalar[] = [];
  let firsts: readonly Scalar[] | undefined;
  for (let i = 0; i < spec.on.length; i++) {
    const path = spec.on[i]!;
    const v = readPath(doc, path);
    if (v === undefined) return NONE;
    if (i === 0 && multi && Array.isArray(v)) {
      for (const e of v) {
        const why = unindexable(e);
        if (why) return { path: path.join("."), why };
      }
      firsts = [...new Set(v as Scalar[])];
      if (firsts.length > MAX_ENTRIES_PER_INDEX) return { path: path.join("."), why: "too-many-entries" };
      values.push(null);
    } else {
      const why = unindexable(v);
      if (why) return { path: path.join("."), why };
      values.push(v as Scalar);
    }
  }

  let value = id;
  let tail: Uint8Array | undefined = id;
  switch (spec.kind) {
    case "sorted":
      if (spec.unique) tail = undefined;
      else value = EMPTY;
      break;
    case "text": {
      const text = readPath(doc, spec.text);
      if (text === undefined) return NONE;
      if (typeof text !== "string") return { path: spec.text.join("."), why: "text-not-string" };
      value = textValue(text);
      break;
    }
  }

  const prefix = plan.target.prefix;
  const out: Entry[] = [];
  for (const first of firsts ?? [values[0]!]) {
    values[0] = first;
    const key = encodeKey(prefix, values, tail);
    if (key.length > MAX_KEY_BYTES) return { path: spec.on.map((p) => p.join(".")).join(","), why: "key-too-long" };
    out.push({ key, value });
  }
  return out;
}
const EMPTY = new Uint8Array(0);

function readPath(doc: StoredDoc, path: Path): unknown {
  let v: unknown = doc;
  for (const segment of path) {
    if (!isObject(v) || !Object.hasOwn(v, segment)) return undefined;
    v = v[segment];
  }
  return v;
}

export function diffEntries(
  before: readonly Entry[],
  after: readonly Entry[],
): { readonly remove: Uint8Array[]; readonly write: readonly Entry[] } {
  if (before.length === 0) return { remove: [], write: after };
  const old = new Map<string, Entry>();
  for (const e of before) old.set(keyString(e.key), e);
  const write: Entry[] = [];
  for (const e of after) {
    const k = keyString(e.key);
    const was = old.get(k);
    if (was === undefined || !bytesEqual(was.value, e.value)) write.push(e);
    old.delete(k);
  }
  return { remove: Array.from(old.values(), (e) => e.key), write };
}
