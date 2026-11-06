import { prefixBound, type BatchTx, type Db } from "@opfs-lsm/kv";
import {
  decodeJson,
  encodeJson,
  extractIndexRowId,
  concatBytes,
  extractSearchRowId,
  indexKey,
  indexPrefix,
  primaryKey,
  searchKey,
  searchPrefix,
  tablePrefix,
  type IndexValue,
} from "./codec.js";
import { diffEntries, type IndexEntry } from "./entries.js";
import { encodeTyped, normalizeIndexValues } from "./typed.js";

export type IndexSpec = {
  /** Index name used in `where(name, value)`. */
  name: string;
  /**
   * Dot-path or compound paths (Dexie-style), e.g. `"email"` or
   * `["orgId", "createdAt"]`.
   */
  path: string | readonly string[];
  /**
   * Index each element of an array-valued path, like IndexedDB's
   * `multiEntry`. A row gets one key per distinct combination of elements,
   * so `path: ["tags", "createdAt"]` keys a row once per tag, each tag's rows
   * in `createdAt` order. A row with an empty array gets no key.
   */
  multiEntry?: boolean;
};

/** Index keys one row may produce, so one combination can't blow the batch limits. */
export const MAX_INDEX_KEYS_PER_ROW = 1_000;

/**
 * Word-prefix text search over one string field. kv has no per-term keys: each
 * row gets one extra key `s/<table>/<sortBy>/<id>` whose value is the
 * normalised text, written in the same batch as the row, and `Table.search`
 * scans those keys in `sortBy` order. A put costs one key more instead of one
 * per word and per prefix.
 */
export type SearchSpec = {
  /** Dot-path of the string field to search. */
  path: string;
  /**
   * Dot-path of the field results are ordered by, ascending, and paged by.
   * Store a descending number (like `Number.MAX_SAFE_INTEGER - createdAt`) for
   * newest first. Treat it as immutable: changing it moves the row's key.
   */
  sortBy: string;
};

export type TableSchema = {
  name: string;
  /** Primary key field (string). Defaults to "id". */
  primaryKey?: string;
  indexes?: IndexSpec[];
  /** Enables `Table.search`. */
  search?: SearchSpec;
};

const EMPTY = new Uint8Array(0);
const SPACE = 0x20;

/** A search value holds ` word word`, so a word that starts with `token` is the bytes ` token`. */
const wordStart = (token: Uint8Array): Uint8Array => concatBytes(new Uint8Array([SPACE]), token);
const encoder = new TextEncoder();

/** Lowercased words (letters and digits) of `text`, in order. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** True when a word of `value` (words joined by single spaces, with a leading space) starts with `token`. */
function hasWordPrefix(value: Uint8Array, token: Uint8Array): boolean {
  const last = value.byteLength - token.byteLength;
  outer: for (let i = 1; i <= last; i++) {
    if (value[i] !== token[0] || value[i - 1] !== 0x20) continue;
    for (let j = 1; j < token.byteLength; j++) if (value[i + j] !== token[j]) continue outer;
    return true;
  }
  return false;
}
/** Primary rows removed per batch in `clear`. 4 ops each keeps this under limits. */
const CLEAR_CHUNK = 1000;

function afterKey(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  return out;
}

function pathsOf(spec: IndexSpec): readonly string[] {
  return typeof spec.path === "string" ? [spec.path] : spec.path;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function asIndexValue(raw: unknown, label: string): IndexValue {
  if (raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return raw;
  throw new TypeError(`${label} must be null|boolean|number|string|Uint8Array`);
}

/**
 * Sort value to put in the search key. The row is JSON, and JSON stores `-0`
 * as `0`, but those two numbers encode to different keys. A key built from
 * the caller's `-0` is invisible to a later read of the stored `0`. Bytes do
 * not survive JSON, so they cannot be a sort value either.
 */
function sortAsStored(raw: IndexValue, label: string): IndexValue {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new TypeError(`${label} number must be finite`);
    return raw === 0 ? 0 : raw;
  }
  if (raw === null || typeof raw === "boolean" || typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) {
    throw new TypeError(`${label} must be a JSON null, boolean, number, or string`);
  }
  const _exhaustive: never = raw;
  throw new TypeError(`${label} is not a stored sort value: ${String(_exhaustive)}`);
}

/**
 * The index values `doc` is keyed under: one list per key, one value per
 * path. Empty when a path is missing, or when a multi-entry path is an empty
 * array.
 */
function readIndexValues(doc: Record<string, unknown>, spec: IndexSpec): IndexValue[][] {
  let rows: IndexValue[][] = [[]];
  for (const path of pathsOf(spec)) {
    const raw = getPath(doc, path);
    if (raw === undefined) return [];
    const label = `index ${spec.name}.${path}`;
    const choices = spec.multiEntry && Array.isArray(raw) ? distinct(raw, label) : [asIndexValue(raw, label)];
    rows = rows.flatMap((row) => choices.map((v) => [...row, v]));
    if (rows.length > MAX_INDEX_KEYS_PER_ROW) {
      throw new RangeError(`index ${spec.name} gives one row more than ${MAX_INDEX_KEYS_PER_ROW} keys`);
    }
  }
  return rows;
}

function distinct(raw: readonly unknown[], label: string): IndexValue[] {
  const out: IndexValue[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const v = asIndexValue(item, label);
    const id = encodeTyped(v).join(",");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  return out;
}

/** @deprecated use extractIndexRowId — kept for string-only tests */
export function extractTrailingId(key: Uint8Array, arity = 1): string | undefined {
  return extractIndexRowId(key, arity);
}

export class Table<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly primaryKeyField: string;
  readonly indexes: readonly IndexSpec[];
  readonly searchSpec: SearchSpec | undefined;

  constructor(
    private readonly db: Db,
    schema: TableSchema,
  ) {
    this.name = schema.name;
    this.primaryKeyField = schema.primaryKey ?? "id";
    this.indexes = schema.indexes ?? [];
    this.searchSpec = schema.search;
  }

  private pkBytes(id: string): Uint8Array {
    return primaryKey(this.name, id);
  }

  /** Every derived entry of `doc`: its index keys, and its search key when the text and sort fields exist. */
  private entriesOf(id: string, doc: T): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const idx of this.indexes) {
      for (const values of readIndexValues(doc, idx)) {
        out.push({ key: indexKey(this.name, idx.name, values, id), value: EMPTY });
      }
    }
    const spec = this.searchSpec;
    if (spec !== undefined) {
      const text = getPath(doc, spec.path);
      const sort = getPath(doc, spec.sortBy);
      if (typeof text === "string" && sort !== undefined) {
        const label = `search.${spec.sortBy}`;
        out.push({
          key: searchKey(this.name, sortAsStored(asIndexValue(sort, label), label), id),
          value: encoder.encode(` ${wordsOf(text).join(" ")}`),
        });
      }
    }
    return out;
  }

  /** Write the row's derived entries that changed from `before` to `after`. */
  private writeEntries(tx: BatchTx, before: readonly IndexEntry[], after: readonly IndexEntry[]): void {
    const { remove, write } = diffEntries(before, after);
    for (const key of remove) tx.delete(key);
    for (const entry of write) tx.put(entry.key, entry.value);
  }

  async get(id: string): Promise<T | undefined> {
    const bytes = await this.db.get(this.pkBytes(id));
    if (bytes === undefined) return undefined;
    return decodeJson<T>(bytes);
  }

  async put(doc: T): Promise<string> {
    const id = requireString(doc[this.primaryKeyField], this.primaryKeyField);
    await this.putMany([doc]);
    return id;
  }

  /**
   * Upsert `docs` (ids must be unique) in one read+write transaction. The
   * caller chunks to stay under the kv batch limits; 1,000 rows is safe.
   */
  async putMany(docs: readonly T[]): Promise<void> {
    if (docs.length === 0) return;
    const ids: string[] = [];
    const pks: Uint8Array[] = [];
    const values: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const doc of docs) {
      const id = requireString(doc[this.primaryKeyField], this.primaryKeyField);
      if (seen.has(id)) {
        throw new Error(`putMany requires unique ids: ${id}`);
      }
      seen.add(id);
      ids.push(id);
      pks.push(this.pkBytes(id));
      values.push(encodeJson(doc));
    }
    await this.db.update(pks, (prevValues, tx) => {
      for (let i = 0; i < docs.length; i++) {
        const prev = prevValues[i];
        const id = ids[i]!;
        const before = prev === undefined ? [] : this.entriesOf(id, decodeJson<T>(prev));
        tx.put(pks[i]!, values[i]!);
        this.writeEntries(tx, before, this.entriesOf(id, docs[i]!));
      }
    });
  }

  /**
   * Read-modify-write one row in a single transaction. `mutate` runs
   * synchronously and must keep the primary key. Only index keys that changed
   * are rewritten, so toggling a non-indexed field touches one row.
   */
  async update(id: string, mutate: (doc: T) => T): Promise<T | undefined> {
    const pk = this.pkBytes(id);
    return this.db.update([pk], ([prevBytes], tx) => {
      if (prevBytes === undefined) return undefined;
      const prev = decodeJson<T>(prevBytes);
      const next = mutate(prev);
      if (next[this.primaryKeyField] !== id) {
        throw new Error("update must not change the primary key");
      }
      tx.put(pk, encodeJson(next));
      this.writeEntries(tx, this.entriesOf(id, prev), this.entriesOf(id, next));
      return next;
    });
  }

  /**
   * Read one cursor page of an index, in index key order. `after` is the
   * `next` from the previous call (inclusive first key). `next` is the first
   * key this call did not consume, so callers can page without rescanning.
   * `value` limits the page to keys equal to it, or starting with it for a
   * compound index, as in `where`.
   */
  async page(
    indexName: string,
    opts: {
      readonly after?: Uint8Array;
      readonly limit: number;
      readonly value?: IndexValue | readonly IndexValue[];
    },
  ): Promise<{ readonly docs: T[]; readonly next?: Uint8Array }> {
    const idx = this.requireIndex(indexName);
    const arity = pathsOf(idx).length;
    const limit = Math.trunc(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer: ${opts.limit}`);
    }
    this.checkBoundArity(indexName, arity, opts.value);

    const whole = prefixBound(
      opts.value === undefined
        ? indexPrefix(this.name, indexName)
        : indexPrefix(this.name, indexName, opts.value),
    );
    const start = opts.after ?? whole.start;
    const hits = await this.db.rangeFollow(
      {
        start,
        ...(whole.endExclusive !== undefined
          ? { endExclusive: whole.endExclusive }
          : {}),
        limit: limit + 1,
      },
      (entry) => {
        const id = extractIndexRowId(entry.key, arity);
        return id === undefined ? undefined : this.pkBytes(id);
      },
    );

    const docs: T[] = [];
    const take = Math.min(limit, hits.length);
    for (let i = 0; i < take; i++) {
      const value = hits[i]!.value;
      if (value !== undefined) docs.push(decodeJson<T>(value));
    }
    const next = hits[limit]?.entry.key;
    return next === undefined ? { docs } : { docs, next };
  }

  /**
   * Delete every row and its index entries in chunks. Returns the row count.
   * Index rows whose primary row is already gone are left alone.
   */
  async clear(): Promise<number> {
    const whole = prefixBound(tablePrefix(this.name));
    let removed = 0;
    let start = whole.start;
    for (;;) {
      const entries: { key: Uint8Array; value: Uint8Array }[] = [];
      for await (const entry of this.db.range({
        start,
        ...(whole.endExclusive !== undefined
          ? { endExclusive: whole.endExclusive }
          : {}),
        limit: CLEAR_CHUNK,
      })) {
        entries.push(entry);
      }
      if (entries.length === 0) return removed;

      await this.db.batch((tx) => {
        for (const entry of entries) {
          tx.delete(entry.key);
          let doc: T;
          try {
            doc = decodeJson<T>(entry.value);
          } catch {
            continue;
          }
          const id = doc[this.primaryKeyField];
          if (typeof id !== "string") continue;
          for (const derived of this.entriesOf(id, doc)) tx.delete(derived.key);
        }
      });
      removed += entries.length;
      start = afterKey(entries[entries.length - 1]!.key);
    }
  }

  async delete(id: string): Promise<boolean> {
    const pk = this.pkBytes(id);
    return this.db.update([pk], ([prevBytes], tx) => {
      if (prevBytes === undefined) return false;
      tx.delete(pk);
      for (const derived of this.entriesOf(id, decodeJson<T>(prevBytes))) tx.delete(derived.key);
      return true;
    });
  }

  /**
   * Equality (or compound prefix) lookup on a declared index.
   * Pass a scalar or an array matching / prefixing the index paths.
   */
  async where(
    indexName: string,
    value: IndexValue | readonly IndexValue[],
  ): Promise<T[]> {
    const idx = this.requireIndex(indexName);
    const arity = pathsOf(idx).length;
    const values = normalizeIndexValues(value);
    if (values.length === 0 || values.length > arity) {
      throw new RangeError(
        `index ${indexName} expects 1..${arity} value(s), got ${values.length}`,
      );
    }
    const eq = prefixBound(indexPrefix(this.name, indexName, values));
    return this.scanIndex(idx, {
      start: eq.start,
      ...(eq.endExclusive !== undefined
        ? { endExclusive: eq.endExclusive }
        : {}),
    });
  }

  /**
   * Walk an index in key order: numbers by value, strings lexicographically.
   * Optional `from` / `toExclusive` are index values (or compound prefixes).
   */
  async orderBy(
    indexName: string,
    opts?: {
      from?: IndexValue | readonly IndexValue[];
      toExclusive?: IndexValue | readonly IndexValue[];
      limit?: number;
    },
  ): Promise<T[]> {
    const idx = this.requireIndex(indexName);
    const arity = pathsOf(idx).length;
    this.checkBoundArity(indexName, arity, opts?.from);
    this.checkBoundArity(indexName, arity, opts?.toExclusive);

    const indexRoot = indexPrefix(this.name, indexName);
    const whole = prefixBound(indexRoot);
    const start =
      opts?.from !== undefined
        ? indexPrefix(this.name, indexName, opts.from)
        : whole.start;

    let endExclusive = whole.endExclusive;
    if (opts?.toExclusive !== undefined) {
      endExclusive = indexPrefix(this.name, indexName, opts.toExclusive);
    } else if (opts?.from !== undefined) {
      const fromArity = normalizeIndexValues(opts.from).length;
      // Partial compound `from` → scan only that prefix (not the rest of the index).
      if (fromArity < arity) {
        endExclusive = prefixBound(start).endExclusive;
      }
    }

    return this.scanIndex(idx, {
      start,
      ...(endExclusive !== undefined ? { endExclusive } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  /**
   * Rows whose search field has, for every word of `text`, a word starting with
   * it (case-insensitive, letters and digits). One cursor page in `sortBy`
   * order: `after` is the `next` of the previous call (inclusive first key),
   * `next` is the first matching key this call did not consume. Scan and row
   * reads see one snapshot, so a put that commits during the call is invisible.
   * Cost is a scan of the search keys until a page fills: a common word returns
   * in microseconds, a word that matches nothing reads every key of the table.
   * kv matches runs inside wasm and yields each key once with its current
   * value, so an overwritten value cannot return a stale row.
   */
  async search(
    text: string,
    opts: { readonly limit: number; readonly after?: Uint8Array },
  ): Promise<{ readonly docs: T[]; readonly next?: Uint8Array }> {
    if (this.searchSpec === undefined) throw new Error(`table ${this.name} has no search spec`);
    const limit = Math.trunc(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive integer: ${opts.limit}`);
    }
    const tokens = wordsOf(text).map((w) => encoder.encode(w));
    if (tokens.length === 0) throw new RangeError("search text has no words");

    const whole = prefixBound(searchPrefix(this.name));
    const range = {
      start: opts.after ?? whole.start,
      ...(whole.endExclusive !== undefined ? { endExclusive: whole.endExclusive } : {}),
    };
    return this.db.view(async (snap) => {
      const ids: string[] = [];
      let next: Uint8Array | undefined;
      for await (const { key, value } of snap.range({ ...range, valueContains: tokens.map(wordStart) })) {
        if (!tokens.every((t) => hasWordPrefix(value, t))) continue;
        if (ids.length === limit) {
          next = key;
          break;
        }
        const id = extractSearchRowId(key);
        if (id !== undefined) ids.push(id);
      }
      const rows = await Promise.all(ids.map((id) => snap.get(this.pkBytes(id))));
      const docs: T[] = [];
      for (const bytes of rows) if (bytes !== undefined) docs.push(decodeJson<T>(bytes));
      return next === undefined ? { docs } : { docs, next };
    });
  }

  private requireIndex(indexName: string): IndexSpec {
    const idx = this.indexes.find((i) => i.name === indexName);
    if (!idx) throw new Error(`unknown index: ${indexName}`);
    return idx;
  }

  private checkBoundArity(
    indexName: string,
    arity: number,
    value: IndexValue | readonly IndexValue[] | undefined,
  ): void {
    if (value === undefined) return;
    const n = normalizeIndexValues(value).length;
    if (n === 0 || n > arity) {
      throw new RangeError(
        `index ${indexName} expects 1..${arity} value(s), got ${n}`,
      );
    }
  }

  private async scanIndex(
    idx: IndexSpec,
    range: {
      start: Uint8Array;
      endExclusive?: Uint8Array;
      limit?: number;
    },
  ): Promise<T[]> {
    const arity = pathsOf(idx).length;
    const hits = await this.db.rangeFollow(range, (entry) => {
      const id = extractIndexRowId(entry.key, arity);
      return id === undefined ? undefined : this.pkBytes(id);
    });
    const docs: T[] = [];
    for (const { value } of hits) {
      if (value !== undefined) docs.push(decodeJson<T>(value));
    }
    return docs;
  }
}
