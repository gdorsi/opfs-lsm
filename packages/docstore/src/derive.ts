import { CorruptDatabaseError, type Entry } from "@opfs-lsm/kv";
import { encodeTuple } from "@opfs-lsm/kv/tuple";
import type { BoundCollection, IndexPlan, Path } from "./catalog.js";
import { DocStoreError } from "./errors.js";
import { MAX_KEY_BYTES, bytesEqual, fromUtf8, keyString, parseId, textValue, utf8, type DocId } from "./keys.js";
import type { JsonDoc, Scalar } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

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

/** Up to about this many characters of JSON go to one JSON.parse and one TextEncoder or TextDecoder call. */
const CHUNK = 64 * 1024;

/**
 * The stored form of each value, `prepare(value)` when given. A chunk of
 * texts is parsed as one JSON array and encoded as one buffer, each `bytes` a
 * view of it: for a small document the cost of a call dominates. Parsing the
 * text, not the bytes, skips a decode. The two agree because
 * `JSON.stringify` escapes lone surrogates.
 */
function encodeDocs(values: readonly unknown[], prepare?: (value: unknown) => unknown): EncodedDoc[] {
  const out: EncodedDoc[] = [];
  let texts: string[] = [];
  let length = 0;
  for (const value of values) {
    const text = JSON.stringify(prepare ? prepare(value) : value) as string | undefined;
    // The JSON of an object, and only of an object, starts with "{".
    if (text?.charCodeAt(0) !== 0x7b) throw new DocStoreError("document", "a document must be a JSON object");
    texts.push(text);
    length += text.length + 1;
    if (length < CHUNK) continue;
    encodeChunk(texts, out);
    texts = [];
    length = 0;
  }
  if (texts.length > 0) encodeChunk(texts, out);
  return out;
}

function encodeChunk(texts: readonly string[], out: EncodedDoc[]): void {
  if (texts.length === 1) {
    const doc = JSON.parse(texts[0]!) as StoredDoc;
    out.push({ id: parseId(doc["id"]), bytes: utf8.encode(texts[0]), doc });
    return;
  }
  const joined = `[${texts.join(",")}]`;
  const docs = JSON.parse(joined) as StoredDoc[];
  const all = utf8.encode(joined);
  // Only ASCII has one byte per UTF-16 unit, so the offsets in `joined` are those in `all`.
  const ascii = all.length === joined.length;
  let at = 1;
  for (let i = 0; i < texts.length; i++) {
    const units = texts[i]!.length;
    const end = ascii ? at + units : utf8End(all, at, units);
    out.push({ id: parseId(docs[i]!["id"]), bytes: all.subarray(at, end), doc: docs[i]! });
    at = end + 1;
  }
}

/** Where the `units` UTF-16 units of well-formed UTF-8 starting at `at` end: a four-byte character is two units. */
function utf8End(bytes: Uint8Array, at: number, units: number): number {
  while (units > 0) {
    const b = bytes[at]!;
    at += b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    units -= b < 0xf0 ? 1 : 2;
  }
  return at;
}

/** What a write of collection `name` encodes for `values`: the output of `validator` for each, or the values themselves. */
export function docEncoder(name: string, validator: StandardSchemaV1 | undefined): (values: readonly unknown[]) => EncodedDoc[] {
  if (!validator) return (values) => encodeDocs(values);
  const validate = (value: unknown) => {
    const result = validator["~standard"].validate(value);
    if (result instanceof Promise) {
      // The write fails here, so a rejection of the Promise would reach nobody.
      result.catch(() => {});
      throw new DocStoreError("invalid", `"${name}": the validator is async`);
    }
    if (!result.issues) return result.value;
    const id = isObject(value) ? value["id"] : undefined;
    const ids = typeof id === "string" ? [id] : undefined;
    throw new DocStoreError("invalid", `"${name}": ${result.issues[0]?.message}`, ids, result.issues);
  };
  return (values) => encodeDocs(values, validate);
}

const NOT_A_DOC = "a stored document is not a JSON object";

export function decodeDoc(bytes: Uint8Array): StoredDoc {
  const parsed: unknown = JSON.parse(fromUtf8.decode(bytes));
  if (!isObject(parsed)) throw new CorruptDatabaseError(NOT_A_DOC);
  return parsed as StoredDoc;
}

/** The buffer of the last batch that finished, for the next one to take. */
let spare: Uint8Array | undefined;

/**
 * Parses stored JSON objects with one TextDecoder call and one JSON.parse per
 * chunk, written as `[a,b,…]` into a buffer of its own. `add` copies the
 * bytes, so it can be a kv `Decode`, and returns the value's slot. `done`
 * parses what is left and gives the value of a slot.
 */
export class JsonBatch<V extends Record<string, unknown> = StoredDoc> {
  private readonly out: V[] = [];
  private buf: Uint8Array | undefined;
  private length = 0;
  private pending = 0;

  constructor(private readonly corrupt = NOT_A_DOC) {}

  readonly add = (bytes: Uint8Array): number => {
    if (this.length + bytes.length + 2 > CHUNK) this.flush();
    if (bytes.length + 2 > CHUNK) return this.out.push(this.object(JSON.parse(fromUtf8.decode(bytes)))) - 1;
    if (!this.buf) {
      this.buf = spare ?? new Uint8Array(CHUNK);
      spare = undefined;
    }
    this.buf[this.length] = this.pending === 0 ? 0x5b : 0x2c;
    this.buf.set(bytes, this.length + 1);
    this.length += bytes.length + 1;
    return this.out.length + this.pending++;
  };

  done(): (slot: number | undefined) => V | undefined {
    this.flush();
    if (this.buf) spare = this.buf;
    this.buf = undefined;
    const out = this.out;
    return (slot) => (slot === undefined ? undefined : out[slot]);
  }

  private flush(): void {
    if (this.pending === 0) return;
    if (this.pending === 1) {
      this.out.push(this.object(JSON.parse(fromUtf8.decode(this.buf!.subarray(1, this.length)))));
      this.length = 0;
      this.pending = 0;
      return;
    }
    this.buf![this.length] = 0x5d;
    const values: unknown = JSON.parse(fromUtf8.decode(this.buf!.subarray(0, this.length + 1)));
    // A value that is not one JSON document could shift the others into its slot.
    if (!Array.isArray(values) || values.length !== this.pending) throw new CorruptDatabaseError(this.corrupt);
    for (const v of values) this.out.push(this.object(v));
    this.length = 0;
    this.pending = 0;
  }

  private object(v: unknown): V {
    if (!isObject(v)) throw new CorruptDatabaseError(this.corrupt);
    return v as V;
  }
}

/** `decodeDoc` of each value, batched when there are several. */
export function decodeDocs(values: readonly (Uint8Array | undefined)[]): (StoredDoc | undefined)[] {
  if (values.length === 1) return [values[0] && decodeDoc(values[0])];
  const batch = new JsonBatch();
  const slots = values.map((v) => v && batch.add(v));
  return slots.map(batch.done());
}

/** Parses the values of covering entries. */
export const fieldsBatch = () => new JsonBatch<Record<string, unknown>>("an index entry's fields are not a JSON object");

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why `v` cannot be one value of a key, or undefined if it can. Numbers from `JSON.parse` are finite. */
function unindexable(v: unknown): Unindexable["why"] | undefined {
  if (v === null || typeof v === "boolean" || typeof v === "number") return undefined;
  if (typeof v === "string") return v.isWellFormed() ? undefined : "lone-surrogate";
  return "not-scalar";
}

const MAX_ENTRIES_PER_INDEX = 1_000;
/**
 * The included fields of one document in one index, counted once per entry.
 * A write and a backfill step each put a document's entries in one kv batch,
 * so without a bound one large field could pass kv's batch limit and leave an
 * index building for good.
 */
const MAX_FIELDS_BYTES = 1024 * 1024;

/** Why one document cannot be in one index. A missing path is not here: it means "not in this index". */
export type Unindexable = {
  readonly path: string;
  readonly why: "not-scalar" | "lone-surrogate" | "text-not-string" | "key-too-long" | "too-many-entries" | "fields-too-large" | "entries-too-large";
};

const NONE: Entry[] = [];

/**
 * Every entry of `doc` in every maintained index; `id` is the id's UTF-8.
 * On the "next" side, the document about to be written, a value an index
 * cannot hold throws, so nothing is stored. On the "stored" side it gives no
 * entries: such a row predates a still-building index and never had any.
 * The entries of unique indexes are also pushed to `unique`. A count index
 * has no entries: the keys of the groups `doc` is in go to `groups` only.
 */
export function entriesOf(
  coll: BoundCollection,
  id: Uint8Array,
  doc: StoredDoc,
  side: "next" | "stored",
  unique?: Entry[],
  groups?: Uint8Array[],
): Entry[] {
  const out: Entry[] = [];
  for (const plan of coll.maintained) {
    const entries = indexEntries(plan, id, doc);
    if (Array.isArray(entries)) {
      if (plan.target.kind === "count") {
        for (const e of entries) groups!.push(e.key);
        continue;
      }
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

/** The entries of `doc` in one index. For a count index, one per group `doc` is in: the group's key, with no value. */
export function indexEntries(plan: IndexPlan, id: Uint8Array, doc: StoredDoc): Entry[] | Unindexable {
  const { spec } = plan;
  const multi = spec.kind !== "text" && spec.multi;
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
      else value = spec.include ? fieldsValue(doc, spec.include) : EMPTY;
      break;
    case "text": {
      const text = readPath(doc, spec.text);
      if (text === undefined) return NONE;
      if (text !== null && typeof text !== "string") return { path: spec.text.join("."), why: "text-not-string" };
      value = textValue(text ?? "");
      break;
    }
    case "count":
      tail = undefined;
      value = EMPTY;
  }

  if (value.length * (firsts?.length ?? 1) > MAX_FIELDS_BYTES && spec.kind === "sorted" && spec.include) {
    return { path: spec.include.join(","), why: "fields-too-large" };
  }

  const prefix = plan.target.prefix;
  // The base row of a group is one byte longer than its key (keys.ts).
  const max = spec.kind === "count" ? MAX_KEY_BYTES - 1 : MAX_KEY_BYTES;
  const out: Entry[] = [];
  for (const first of firsts ?? [values[0]!]) {
    values[0] = first;
    const key = encodeTuple(values, prefix, tail);
    if (key.length > max) return { path: spec.on.map((p) => p.join(".")).join(","), why: "key-too-long" };
    out.push({ key, value });
  }
  return out;
}
const EMPTY = new Uint8Array(0);

function fieldsValue(doc: StoredDoc, include: readonly string[]): Uint8Array {
  // No prototype, so a field named "__proto__" is copied like any other.
  const fields: Record<string, unknown> = Object.create(null);
  for (const f of include) if (Object.hasOwn(doc, f)) fields[f] = doc[f];
  return utf8.encode(JSON.stringify(fields));
}

function readPath(doc: StoredDoc, path: Path): unknown {
  let v: unknown = doc;
  for (const segment of path) {
    if (!isObject(v) || !Object.hasOwn(v, segment)) return undefined;
    v = v[segment];
  }
  return v;
}

/** Up to this many entries on each side `diffEntries` compares keys byte by byte, with no map. At most 32, the width of its bit mask. */
const SMALL_DIFF = 16;

/** The entries of `after` to write, and the keys of `before` to remove, each in list order. The keys of one list must be distinct, as those of `entriesOf` are. */
export function diffEntries(
  before: readonly Entry[],
  after: readonly Entry[],
): { readonly remove: Uint8Array[]; readonly write: readonly Entry[] } {
  if (before.length === 0) return { remove: [], write: after };
  if (before.length <= SMALL_DIFF && after.length <= SMALL_DIFF) return diffSmall(before, after);
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

/** No string per key: both lists come from the same indexes, so the entry at the same position is the usual match, and a search runs only when it is not. */
function diffSmall(before: readonly Entry[], after: readonly Entry[]) {
  let kept = 0;
  const write: Entry[] = [];
  for (let i = 0; i < after.length; i++) {
    const e = after[i]!;
    let j = i;
    if (i >= before.length || !bytesEqual(before[i]!.key, e.key)) {
      j = 0;
      while (j < before.length && !bytesEqual(before[j]!.key, e.key)) j++;
    }
    if (j === before.length) write.push(e);
    else {
      kept |= 1 << j;
      if (!bytesEqual(before[j]!.value, e.value)) write.push(e);
    }
  }
  const remove: Uint8Array[] = [];
  for (let j = 0; j < before.length; j++) if ((kept & (1 << j)) === 0) remove.push(before[j]!.key);
  return { remove, write };
}
