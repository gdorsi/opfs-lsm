/**
 * The open store: owns this handle's copy of the catalog and the write and
 * read protocols every collection goes through. Only this module reads or
 * writes CATALOG_KEY.
 */
import { CorruptDatabaseError, type BatchTx, type Db } from "@opfs-lsm/kv";
import {
  bind,
  encodeCatalog,
  normalizeSchema,
  parseCatalog,
  reconcile,
  type Bound,
  type BoundCollection,
  type DeclaredSchema,
} from "./catalog.js";
import { CollectionImpl, RETRY, type Collection } from "./collection.js";
import { DocStoreError } from "./errors.js";
import { CATALOG_KEY, bytesEqual, type ScanTarget } from "./keys.js";
import type { AnySchema, CollectionName, DocOf, IndexesOf } from "./schema.js";

export interface DocStore<S extends AnySchema> {
  /** A typed handle. Operations on a collection the stored catalog lacks throw "schema". */
  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>>;
}

/**
 * Bring the stored catalog in line with `schema` and return the store. The
 * caller owns `kv`: it opened it and closes it, and keeps using it for
 * `changes`, `ingest` and other layers. Keys starting with 0x64 belong to
 * this package.
 */
export async function openDocStore<S extends AnySchema>(kv: Db, schema: S): Promise<DocStore<S>> {
  const declared = normalizeSchema(schema);
  const { bytes, catalog } = await kv.update([CATALOG_KEY], ([stored], tx) => {
    const current = stored && parseCatalog(stored);
    const r = reconcile(current, declared);
    switch (r.kind) {
      case "error":
        throw r.error;
      case "keep":
        return { bytes: stored!, catalog: current! };
      case "write": {
        const out = encodeCatalog(r.catalog);
        tx.put(CATALOG_KEY, out);
        return { bytes: out, catalog: r.catalog };
      }
    }
  });
  return new DocStoreImpl<S>(kv, declared, bind(bytes, catalog, declared));
}

/** A write planned against one catalog. */
export type WritePlan<R> = {
  /** Point keys the body reads, after CATALOG_KEY, which the store puts first. */
  readonly keys: readonly Uint8Array[];
  /** Runs inside kv's `update` with the values of `keys`. RETRY must leave `tx` empty. */
  readonly apply: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => R | typeof RETRY;
};

/** What a collection may ask of the store. */
export interface StoreCore {
  readonly kv: Db;
  /** The collection in a freshly read catalog. */
  current(name: string): Promise<BoundCollection>;
  /** One kv `update`, planned against this handle's catalog and planned again whenever the stored catalog differs. */
  write<R>(name: string, planner: (coll: BoundCollection) => WritePlan<R> | Promise<WritePlan<R>>): Promise<R>;
  /** One read between two catalog reads, repeated until the collection id and index id did not change in between. */
  read<R>(name: string, index: string | undefined, read: (target: ScanTarget) => Promise<R | typeof RETRY>): Promise<R>;
}

function collectionOf(bound: Bound, name: string): BoundCollection {
  const coll = bound.collections.get(name);
  if (!coll) throw new DocStoreError("schema", `the stored catalog has no collection "${name}"`);
  return coll;
}

function readableTarget(coll: BoundCollection, index: string): ScanTarget {
  const r = coll.readable.get(index);
  if (r === undefined) throw new DocStoreError("schema", `"${coll.name}" has no index "${index}" in this schema`);
  if (!("kind" in r)) return r.target;
  const where = `index "${index}" of "${coll.name}"`;
  switch (r.kind) {
    case "missing":
      throw new DocStoreError("schema", `the stored catalog has no ${where}`);
    case "spec-changed":
      throw new DocStoreError("schema", `a newer schema redefined ${where}`);
    case "building":
      throw new DocStoreError("schema", `a newer schema is building ${where}`);
    case "failed":
      throw new DocStoreError("index-failed", `${where} cannot hold the stored data (${r.reason})`, r.ids);
  }
}

function readableId(coll: BoundCollection | undefined, index: string): number | undefined {
  const r = coll?.readable.get(index);
  return r && !("kind" in r) ? r.id : undefined;
}

class DocStoreImpl<S extends AnySchema> implements DocStore<S>, StoreCore {
  constructor(
    readonly kv: Db,
    private readonly declared: DeclaredSchema,
    private bound: Bound,
  ) {}

  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>> {
    return new CollectionImpl(this, name);
  }

  async current(name: string): Promise<BoundCollection> {
    return collectionOf(this.adopt(await this.kv.get(CATALOG_KEY)), name);
  }

  async write<R>(name: string, planner: (coll: BoundCollection) => WritePlan<R> | Promise<WritePlan<R>>): Promise<R> {
    for (;;) {
      const bound = this.bound;
      const plan = await planner(collectionOf(bound, name));
      const out = await this.kv.update([CATALOG_KEY, ...plan.keys], ([catalog, ...values], tx) => {
        if (!bytesEqual(catalog, bound.bytes)) {
          this.adopt(catalog);
          return RETRY;
        }
        return plan.apply(values, tx);
      });
      if (out !== RETRY) return out;
    }
  }

  /**
   * Ids are never reused and a ready index never goes back to building, so
   * an unchanged collection id and index id before and after mean no `clear`,
   * drop or redefinition touched the scanned prefix while the read ran.
   */
  async read<R>(
    name: string,
    index: string | undefined,
    read: (target: ScanTarget) => Promise<R | typeof RETRY>,
  ): Promise<R> {
    for (;;) {
      const before = await this.current(name);
      const out = await read(index === undefined ? before.rows : readableTarget(before, index));
      const after = this.adopt(await this.kv.get(CATALOG_KEY)).collections.get(name);
      if (after?.id !== before.id || (index !== undefined && readableId(after, index) !== readableId(before, index))) {
        continue;
      }
      if (out === RETRY) throw new CorruptDatabaseError(`an index entry of "${name}" points at a missing document`);
      return out;
    }
  }

  /** Recompile only when the stored bytes changed. */
  private adopt(bytes: Uint8Array | undefined): Bound {
    if (!bytes) throw new CorruptDatabaseError("the docstore catalog is gone");
    if (!bytesEqual(bytes, this.bound.bytes)) this.bound = bind(bytes, parseCatalog(bytes), this.declared);
    return this.bound;
  }
}
