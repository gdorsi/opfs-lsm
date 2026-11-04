import { prefixBound, type Db } from "@opfs-lsm/kv";
import {
  decodeJson,
  encodeJson,
  extractIndexRowId,
  indexKey,
  indexPrefix,
  primaryKey,
  type IndexValue,
} from "./codec.js";
import { normalizeIndexValues } from "./typed.js";

export type IndexSpec = {
  /** Index name used in `where(name, value)`. */
  name: string;
  /**
   * Dot-path or compound paths (Dexie-style), e.g. `"email"` or
   * `["orgId", "createdAt"]`.
   */
  path: string | readonly string[];
};

export type TableSchema = {
  name: string;
  /** Primary key field (string). Defaults to "id". */
  primaryKey?: string;
  indexes?: IndexSpec[];
};

const EMPTY = new Uint8Array(0);

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

function readIndexValues(
  doc: Record<string, unknown>,
  paths: readonly string[],
  indexName: string,
): IndexValue[] | undefined {
  const out: IndexValue[] = [];
  for (const path of paths) {
    const raw = getPath(doc, path);
    if (raw === undefined) return undefined;
    out.push(asIndexValue(raw, `index ${indexName}.${path}`));
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
      const values = readIndexValues(doc, pathsOf(idx), idx.name);
      if (values === undefined) continue;
      out.push(indexKey(this.name, idx.name, values, id));
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
    const pk = this.pkBytes(id);
    const value = encodeJson(doc);
    return this.db.update([pk], ([prevBytes], tx) => {
      if (prevBytes !== undefined) {
        for (const key of this.indexKeys(id, decodeJson<T>(prevBytes))) {
          tx.delete(key);
        }
      }
      tx.put(pk, value);
      for (const key of this.indexKeys(id, doc)) tx.put(key, EMPTY);
      return id;
    });
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
   * Walk an index in key order (typed value encoding order).
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
