import { prefixBound, type Db } from "@opfs-lsm/kv";
import {
  decodeJson,
  encodeJson,
  extractIndexRowId,
  indexKey,
  indexPrefix,
  primaryKey,
  tablePrefix,
  type IndexValue,
} from "./codec.js";
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

export type TableSchema = {
  name: string;
  /** Primary key field (string). Defaults to "id". */
  primaryKey?: string;
  indexes?: IndexSpec[];
};

const EMPTY = new Uint8Array(0);
/** Primary rows removed per batch in `clear`. 4 ops each keeps this under limits. */
const CLEAR_CHUNK = 1000;

function afterKey(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

  constructor(
    private readonly db: Db,
    schema: TableSchema,
  ) {
    this.name = schema.name;
    this.primaryKeyField = schema.primaryKey ?? "id";
    this.indexes = schema.indexes ?? [];
  }

  private pkBytes(id: string): Uint8Array {
    return primaryKey(this.name, id);
  }

  private indexKeys(id: string, doc: T): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const idx of this.indexes) {
      for (const values of readIndexValues(doc, idx)) {
        out.push(indexKey(this.name, idx.name, values, id));
      }
    }
    return out;
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
        if (prev !== undefined) {
          for (const key of this.indexKeys(id, decodeJson<T>(prev))) {
            tx.delete(key);
          }
        }
        tx.put(pks[i]!, values[i]!);
        for (const key of this.indexKeys(id, docs[i]!)) tx.put(key, EMPTY);
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
      const before = this.indexKeys(id, prev);
      const after = this.indexKeys(id, next);
      for (const key of before) {
        if (!after.some((other) => sameBytes(other, key))) tx.delete(key);
      }
      for (const key of after) {
        if (!before.some((other) => sameBytes(other, key))) tx.put(key, EMPTY);
      }
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
          for (const key of this.indexKeys(id, doc)) tx.delete(key);
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
      for (const key of this.indexKeys(id, decodeJson<T>(prevBytes))) {
        tx.delete(key);
      }
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
