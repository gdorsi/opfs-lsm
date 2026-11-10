/**
 * One collection: documents by id, and reads over one index range. Every
 * write is one `store.write` (one kv `update`), every range read one
 * `store.read`. This file owns what a write does to rows and entries;
 * store.ts owns the catalog and the retry rules around them.
 */
import type { Entry, Range } from "@opfs-lsm/kv";
import type { BoundCollection } from "./catalog.js";
import { decodeDoc, diffEntries, encodeDoc, entriesOf, type EncodedDoc, type StoredDoc } from "./derive.js";
import { DocStoreError } from "./errors.js";
import {
  bytesEqual,
  concat,
  encodeCursor,
  entryId,
  idBytes,
  keyString,
  parseId,
  scanPlan,
  type DocId,
} from "./keys.js";
import type { Cursor, IdPage, JsonDoc, Page, Query, QueryInput } from "./schema.js";
import type { StoreCore, WritePlan } from "./store.js";

export interface Collection<T extends JsonDoc, Ix> {
  readonly name: string;

  /** The stored document, or undefined. */
  get(id: string): Promise<T | undefined>;
  /** In the order of `ids`. Each row is current when read; the set is not one snapshot. */
  getMany(ids: readonly string[]): Promise<(T | undefined)[]>;

  /** Upsert. See `putMany`. */
  put(doc: T): Promise<void>;
  /**
   * Upsert every document in one kv transaction: all land or none do. A
   * document whose stored bytes would not change writes nothing. Throws
   * DocStoreError "document" on a bad or repeated id or a value an index
   * cannot hold, "unique" if two documents would share a unique value, and
   * kv's ConstraintError over kv's batch limits.
   */
  putMany(docs: readonly T[]): Promise<void>;
  /**
   * Read-modify-write one document. `fn` gets the stored form and returns
   * the next document with the same id. It may run more than once, so it
   * must be pure. Returns the stored form of the result, or undefined if
   * there was no document (then `fn` does not run).
   */
  modify(id: string, fn: (doc: T) => T): Promise<T | undefined>;

  /** True if there was a document. */
  delete(id: string): Promise<boolean>;
  /** One transaction. Returns how many of the distinct ids existed. */
  deleteMany(ids: readonly string[]): Promise<number>;

  /**
   * One page of documents in index order (`reverse`: descending). `next` is
   * set iff more entries follow; pass it as `after`. A multi index returns a
   * document once per matching element.
   */
  query(q: Query<T, Ix>): Promise<Page<T>>;
  /** As `query`, without reading the documents. */
  queryIds(q: Query<T, Ix>): Promise<IdPage>;
  /** How many entries `query` would walk, stopping at `limit` if given. */
  count(q: Query<T, Ix>): Promise<number>;
}

/** A write body or a read that must start over. */
export const RETRY: unique symbol = Symbol("retry");

const fromUtf8 = new TextDecoder();
const NONE: readonly Entry[] = [];

/**
 * A row read before the transaction. The body retries unless the row still
 * holds `bytes`. `owned` lists the row's unique entries while some unique
 * index is building, and is empty otherwise.
 */
type Prior = {
  readonly bytes: Uint8Array | undefined;
  readonly before: readonly Entry[];
  readonly owned: readonly Entry[];
};

/**
 * While a unique index is building, two old rows may share a value and the
 * entry belongs to whichever row the backfill reached first, so a row may
 * remove a unique entry only after reading who owns it. Which keys to read
 * depends on the old row, and `update` reads only keys named up front: such
 * writes read their rows before the transaction. Once every unique index is
 * ready, a row's unique entries are its own.
 */
const buildingUnique = (coll: BoundCollection) =>
  coll.maintained.some((p) => p.target.kind === "unique" && p.state.kind === "building");

function priorOf(coll: BoundCollection, idb: Uint8Array, bytes: Uint8Array | undefined, doc?: StoredDoc): Prior {
  if (!bytes) return { bytes, before: NONE, owned: NONE };
  const owned: Entry[] | undefined = buildingUnique(coll) ? [] : undefined;
  return { bytes, before: entriesOf(coll, idb, doc ?? decodeDoc(bytes), "stored", owned), owned: owned ?? NONE };
}

/**
 * One transaction that writes `docs[i]` under `ids[i]`, or deletes the row
 * when it is undefined, and returns how many of the rows existed. Without
 * `prior` the old rows are read inside the transaction.
 *
 * A unique key conflicts when its owner is another id outside the batch. A
 * batch member that owns a key and no longer claims it releases it, so every
 * delete of the batch goes out before any put.
 */
function planChanges(
  coll: BoundCollection,
  ids: readonly DocId[],
  docs: readonly (EncodedDoc | undefined)[],
  prior?: readonly Prior[],
): WritePlan<number> {
  const n = ids.length;
  const idbs = ids.map(idBytes);
  const rowKeys = idbs.map((b) => concat(coll.rows.prefix, b));
  const after: (readonly Entry[])[] = [];
  const claims = new Map<string, { readonly key: Uint8Array; readonly at: number }>();
  for (let i = 0; i < n; i++) {
    const doc = docs[i];
    if (!doc) {
      after.push(NONE);
      continue;
    }
    const unique: Entry[] = [];
    after.push(entriesOf(coll, idbs[i]!, doc.doc, "next", unique));
    for (const u of unique) {
      const k = keyString(u.key);
      const other = claims.get(k);
      if (other) throw uniqueError(ids[i]!, ids[other.at]!);
      claims.set(k, { key: u.key, at: i });
    }
  }
  const claimed = [...claims.values()];
  const owners = new Map<string, number>();
  const ownedKeys: Uint8Array[] = [];
  for (const p of prior ?? []) {
    for (const u of p.owned) {
      owners.set(keyString(u.key), n + claimed.length + ownedKeys.length);
      ownedKeys.push(u.key);
    }
  }
  const batch = new Set<string>(ids);

  return {
    keys: [...rowKeys, ...claimed.map((c) => c.key), ...ownedKeys],
    apply: (values, tx) => {
      if (prior?.some((p, i) => !bytesEqual(p.bytes, values[i]))) return RETRY;
      for (let j = 0; j < claimed.length; j++) {
        const { at } = claimed[j]!;
        const owner = values[n + j];
        if (owner === undefined || bytesEqual(owner, idbs[at]) || bytesEqual(values[at], docs[at]!.bytes)) continue;
        const ownerId = fromUtf8.decode(owner);
        if (!batch.has(ownerId)) throw uniqueError(ids[at]!, ownerId);
      }
      const removes: Uint8Array[] = [];
      const writes: Entry[] = [];
      let existed = 0;
      for (let i = 0; i < n; i++) {
        const old = values[i];
        const doc = docs[i];
        if (old) existed++;
        if (doc ? bytesEqual(old, doc.bytes) : old === undefined) continue;
        if (doc) tx.put(rowKeys[i]!, doc.bytes);
        else tx.delete(rowKeys[i]!);
        const before = prior ? prior[i]!.before : old ? entriesOf(coll, idbs[i]!, decodeDoc(old), "stored") : NONE;
        const diff = diffEntries(before, after[i]!);
        for (const k of diff.remove) {
          const at = owners.get(keyString(k));
          if (at === undefined || bytesEqual(values[at], idbs[i])) removes.push(k);
        }
        for (const e of diff.write) writes.push(e);
      }
      for (const k of removes) tx.delete(k);
      for (const e of writes) tx.put(e.key, e.value);
      return existed;
    },
  };
}

function uniqueError(incoming: string, owner: string): DocStoreError {
  return new DocStoreError("unique", `"${incoming}" and "${owner}" would share a unique value`, [incoming, owner]);
}

function limitOf(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new DocStoreError("query", "limit must be a positive integer");
}

function withLimit(range: Range, limit: number | undefined): Range {
  return limit === undefined ? range : { ...range, limit };
}

function nextOf(keys: readonly Uint8Array[], limit: number | undefined): { next?: Cursor } {
  return limit !== undefined && keys.length > limit ? { next: encodeCursor(keys[limit - 1]!) } : {};
}

async function collect(entries: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of entries) out.push(e);
  return out;
}

export class CollectionImpl<T extends JsonDoc, Ix> implements Collection<T, Ix> {
  constructor(
    private readonly store: StoreCore,
    readonly name: string,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const idb = idBytes(parseId(id));
    const coll = await this.store.current(this.name);
    const bytes = await this.store.kv.get(concat(coll.rows.prefix, idb));
    return bytes && (decodeDoc(bytes) as unknown as T);
  }

  async getMany(ids: readonly string[]): Promise<(T | undefined)[]> {
    const idbs = ids.map((id) => idBytes(parseId(id)));
    const coll = await this.store.current(this.name);
    const rows = await Promise.all(idbs.map((b) => this.store.kv.get(concat(coll.rows.prefix, b))));
    return rows.map((bytes) => bytes && (decodeDoc(bytes) as unknown as T));
  }

  put(doc: T): Promise<void> {
    return this.putMany([doc]);
  }

  async putMany(docs: readonly T[]): Promise<void> {
    const encoded = docs.map(encodeDoc);
    const ids = encoded.map((e) => e.id);
    if (new Set(ids).size !== ids.length) throw new DocStoreError("document", "putMany got one id twice");
    await this.store.write(this.name, async (coll) =>
      planChanges(coll, ids, encoded, buildingUnique(coll) ? await this.priors(coll, ids) : undefined),
    );
  }

  /** Optimistic: the unique keys to read depend on the new document, which depends on the old row. */
  modify(id: string, fn: (doc: T) => T): Promise<T | undefined> {
    const docId = parseId(id);
    const idb = idBytes(docId);
    return this.store.write(this.name, async (coll): Promise<WritePlan<T | undefined>> => {
      const rowKey = concat(coll.rows.prefix, idb);
      const bytes = await this.store.kv.get(rowKey);
      if (!bytes) return { keys: [rowKey], apply: ([row]) => (row === undefined ? undefined : RETRY) };
      const doc = decodeDoc(bytes);
      const prior = priorOf(coll, idb, bytes, doc);
      const next = encodeDoc(fn(doc as unknown as T));
      if (next.id !== docId) throw new DocStoreError("document", `modify changed the id of "${docId}"`);
      const plan = planChanges(coll, [docId], [next], [prior]);
      return {
        keys: plan.keys,
        apply: (values, tx) => (plan.apply(values, tx) === RETRY ? RETRY : (next.doc as unknown as T)),
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany([id])) > 0;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    const distinct = [...new Set(ids.map(parseId))];
    return this.store.write(this.name, async (coll) =>
      planChanges(
        coll,
        distinct,
        distinct.map(() => undefined),
        buildingUnique(coll) ? await this.priors(coll, distinct) : undefined,
      ),
    );
  }

  private priors(coll: BoundCollection, ids: readonly DocId[]): Promise<Prior[]> {
    return Promise.all(
      ids.map(async (id) => {
        const idb = idBytes(id);
        return priorOf(coll, idb, await this.store.kv.get(concat(coll.rows.prefix, idb)));
      }),
    );
  }

  query(q: Query<T, Ix>): Promise<Page<T>> {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    return this.store.read(this.name, input.index, async (target) => {
      const range = withLimit(scanPlan(target, input).range, limit === undefined ? undefined : limit + 1);
      if (target.kind === "rows") {
        const hits = await collect(this.store.kv.range(range));
        const docs = hits.slice(0, limit).map((h) => decodeDoc(h.value) as unknown as T);
        return { docs, ...nextOf(hits.map((h) => h.key), limit) };
      }
      let followed = 0;
      const hits = await this.store.kv.rangeFollow(range, (e) =>
        limit === undefined || followed++ < limit ? concat(target.rowPrefix, entryId(target, e.key, e.value)) : undefined,
      );
      const docs: T[] = [];
      for (const { value } of hits.slice(0, limit)) {
        if (value === undefined) return RETRY;
        docs.push(decodeDoc(value) as unknown as T);
      }
      return { docs, ...nextOf(hits.map((h) => h.entry.key), limit) };
    });
  }

  queryIds(q: Query<T, Ix>): Promise<IdPage> {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    return this.store.read(this.name, input.index, async (target) => {
      const range = withLimit(scanPlan(target, input).range, limit === undefined ? undefined : limit + 1);
      const hits = await collect(this.store.kv.range(range));
      const ids = hits.slice(0, limit).map((h) => fromUtf8.decode(entryId(target, h.key, h.value)));
      return { ids, ...nextOf(hits.map((h) => h.key), limit) };
    });
  }

  count(q: Query<T, Ix>): Promise<number> {
    const input = q as QueryInput;
    const limit = limitOf(input.limit);
    return this.store.read(this.name, input.index, async (target) => {
      let n = 0;
      for await (const _ of this.store.kv.range(withLimit(scanPlan(target, input).range, limit))) n++;
      return n;
    });
  }
}
