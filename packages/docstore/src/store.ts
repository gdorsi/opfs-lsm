import { CorruptDatabaseError, prefixBound, type BatchTx, type ChangeEvent, type Db, type Entry } from "@opfs-lsm/kv";
import {
  bind,
  clearCollection,
  describeIndexes,
  encodeCatalog,
  markFailed,
  markReady,
  normalizeSchema,
  parseCatalog,
  reconcile,
  removeDropped,
  type Bound,
  type BoundCollection,
  type DeclaredSchema,
  type DroppedPrefix,
  type IndexPlan,
  type StoredCatalog,
} from "./catalog.js";
import { CollectionImpl, RETRY, type Collection } from "./collection.js";
import { decodeDoc, indexEntries, type Unindexable } from "./derive.js";
import { DocStoreError } from "./errors.js";
import {
  CATALOG_KEY,
  after,
  bytesEqual,
  compareBytes,
  collectionPrefix,
  indexPrefix,
  keyString,
  upperOf,
  type CollectionId,
  type IndexId,
} from "./keys.js";
import type { AnySchema, CollectionName, DocOf, IndexesOf } from "./schema.js";

export interface DocStore<S extends AnySchema> {
  /** A typed handle. Operations on a collection the stored catalog lacks throw "schema". */
  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>>;
  /** Resolves when this handle's background backfills and sweeps have finished. */
  whenIdle(): Promise<void>;
}

/**
 * Bring the stored catalog in line with `schema` and return the store. Open
 * waits for the indexes `schema` declares, so each is ready or failed once
 * it resolves. The caller owns `kv`: it opened it and closes it, and keeps
 * using it for `changes`, `ingest` and other layers. Keys starting with
 * 0x64 belong to this package.
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
  const store = new DocStoreImpl<S>(kv, declared, bind(bytes, catalog, declared));
  store.startJobs();
  await store.declaredBuilds();
  return store;
}

export type WritePlan<R> = {
  /** Point keys the body reads, after CATALOG_KEY, which the store puts first. */
  readonly keys: readonly Uint8Array[];
  /** Runs inside kv's `update` with the values of `keys`. RETRY must leave `tx` empty. */
  readonly apply: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => R | typeof RETRY;
};

export interface StoreCore {
  readonly kv: Db;
  /** The collection in this handle's catalog, for a point read outside a snapshot. */
  collectionNow(name: string): Promise<BoundCollection>;
  /** The collection in the catalog `bytes`, which a kv snapshot read. */
  collectionIn(bytes: Uint8Array | undefined, name: string): BoundCollection;
  /** One kv `update`, planned against this handle's catalog and planned again whenever the stored catalog differs. */
  write<R>(name: string, planner: (coll: BoundCollection) => WritePlan<R> | Promise<WritePlan<R>>): Promise<R>;
  clear(name: string): Promise<void>;
}

const BACKFILL_ROWS = 500;
const BACKFILL_OPS = 8_000;
const BACKFILL_BYTES = 4 * 1024 * 1024;
const SWEEP_KEYS = 1_000;
const fromUtf8 = new TextDecoder();

type Violation = { readonly reason: "unique" | "value"; readonly ids: readonly string[] };

function collectionOf(bound: Bound, name: string): BoundCollection {
  const coll = bound.collections.get(name);
  if (!coll) throw new DocStoreError("schema", `the stored catalog has no collection "${name}"`);
  return coll;
}

const backfillKey = (coll: BoundCollection, plan: IndexPlan) => `backfill ${coll.id} ${plan.id}`;

class DocStoreImpl<S extends AnySchema> implements DocStore<S>, StoreCore {
  private readonly jobs = new Map<string, Promise<void>>();
  /**
   * `bound` may be behind the stored catalog: the next point read reads it
   * again. Set by a kv gap, which may have skipped a catalog write, and at
   * open, for a write between open's read and the subscription.
   */
  private stale = true;
  private rereading: Promise<void> | undefined;
  /** Catalog writes the feed delivered, so a reread that one overtook is dropped. */
  private catalogWrites = 0;

  constructor(
    readonly kv: Db,
    private readonly declared: DeclaredSchema,
    private bound: Bound,
  ) {
    // The store has no close. The listener lets it go once nothing else holds it, and kv drops the listener when it closes.
    const store = new WeakRef(this);
    const off = kv.changes((event) => {
      const live = store.deref();
      if (live) live.follow(event);
      else off();
    });
  }

  /** Keep `bound` at the catalog kv last announced, so point reads need not read it. */
  private follow(event: ChangeEvent): void {
    if (event.kind === "gap") this.stale = true;
    if (event.kind !== "append") return;
    for (const op of event.ops) {
      if (op.type === "deleteRange") {
        const covers =
          compareBytes(op.start, CATALOG_KEY) <= 0 &&
          (op.endExclusive === undefined || compareBytes(op.endExclusive, CATALOG_KEY) > 0);
        if (covers) this.stale = true;
        continue;
      }
      if (!bytesEqual(op.key, CATALOG_KEY)) continue;
      this.catalogWrites++;
      try {
        // Copied: the bytes are a view of a memtable chunk, which `bound` would keep alive.
        this.adopt(op.type === "put" ? op.value.slice() : undefined);
      } catch {
        // The reread throws it to the reader.
        this.stale = true;
      }
    }
  }

  async collectionNow(name: string): Promise<BoundCollection> {
    while (this.stale || this.rereading) await (this.rereading ??= this.reread());
    return collectionOf(this.bound, name);
  }

  private async reread(): Promise<void> {
    this.stale = false;
    const seen = this.catalogWrites;
    try {
      const bytes = await this.kv.get(CATALOG_KEY);
      if (seen === this.catalogWrites) this.adopt(bytes);
    } catch (err) {
      this.stale = true;
      throw err;
    } finally {
      this.rereading = undefined;
    }
  }

  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>> {
    return new CollectionImpl(this, name, describeIndexes(this.declared.collections.get(name)));
  }

  async whenIdle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all(this.jobs.values());
  }

  declaredBuilds(): Promise<unknown> {
    const builds = [...this.bound.collections.values()].flatMap((coll) =>
      coll.maintained.flatMap((plan) => {
        const r = coll.readable.get(plan.name);
        return r && "kind" in r && r.kind === "building" ? [this.jobs.get(backfillKey(coll, plan))] : [];
      }),
    );
    return Promise.all(builds);
  }

  collectionIn(bytes: Uint8Array | undefined, name: string): BoundCollection {
    return collectionOf(this.adopt(bytes), name);
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

  async clear(name: string): Promise<void> {
    await this.editCatalog((c) => clearCollection(c, name));
    this.startJobs();
  }

  /**
   * Apply a transition in one `update([CATALOG_KEY])`. Transitions return
   * undefined once applied, so a repeat writes nothing. `bound` holds the
   * result once this resolves: kv announces a write before it resolves it
   * (the contract on kv's `ChangeEvent`), and `follow` adopts it.
   */
  private async editCatalog(edit: (c: StoredCatalog) => StoredCatalog | undefined): Promise<void> {
    await this.kv.update([CATALOG_KEY], ([stored], tx) => {
      const next = edit(this.adopt(stored).catalog);
      if (next) tx.put(CATALOG_KEY, encodeCatalog(next));
    });
  }

  private adopt(bytes: Uint8Array | undefined): Bound {
    if (!bytes) throw new CorruptDatabaseError("the docstore catalog is gone");
    if (!bytesEqual(bytes, this.bound.bytes)) this.bound = bind(bytes, parseCatalog(bytes), this.declared);
    return this.bound;
  }

  startJobs(): void {
    for (const coll of this.bound.collections.values()) {
      for (const plan of coll.maintained) {
        if (plan.state.kind === "building") this.job(backfillKey(coll, plan), () => this.backfill(coll.name, plan.id));
      }
    }
    for (const p of this.bound.catalog.dropped) {
      this.job(`sweep ${p.collection} ${"index" in p ? p.index : "all"}`, () => this.sweep(p));
    }
  }

  private job(key: string, run: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    // Start on the next task: kv's first scan copies every memtable row in its
    // bounds at once, which would otherwise run inside the caller's `clear`.
    const job = new Promise((r) => setTimeout(r)).then(run).finally(() => this.jobs.delete(key));
    job.catch(() => undefined);
    this.jobs.set(key, job);
  }

  /**
   * Fill a building index from the rows, then mark it ready. Any handle may
   * run it, and two at once put the same entries. A row whose bytes changed
   * since its chunk was scanned makes the chunk rescan: the write that changed
   * it diffed against the old row, so an entry both versions derive may be in
   * neither the write nor this index yet.
   * A crash leaves the index building and the next open starts over.
   * Progress is not stored, because storing it in the catalog would make
   * every concurrent writer retry once per chunk.
   */
  private async backfill(collection: string, index: IndexId): Promise<void> {
    let from: Uint8Array | undefined;
    for (;;) {
      const bound = this.bound;
      const coll = bound.collections.get(collection);
      const plan = coll?.maintained.find((p) => p.id === index);
      if (!coll || !plan || plan.state.kind !== "building") return;
      const rowPrefix = coll.rows.prefix;
      const rows: Entry[] = [];
      const derived: (Entry[] | Unindexable)[] = [];
      let ops = 0;
      let bytes = 0;
      const range = { start: from ? after(from) : rowPrefix, endExclusive: upperOf(rowPrefix), limit: BACKFILL_ROWS };
      for await (const row of this.kv.range(range)) {
        const entries = indexEntries(plan, row.key.subarray(rowPrefix.length), decodeDoc(row.value));
        rows.push(row);
        derived.push(entries);
        if (!Array.isArray(entries)) continue;
        ops += entries.length;
        for (const e of entries) bytes += e.key.length + e.value.length;
        if (ops >= BACKFILL_OPS || bytes >= BACKFILL_BYTES) break;
      }
      if (rows.length === 0) {
        await this.editCatalog((c) => markReady(c, collection, index));
        return;
      }

      const unique = plan.target.kind === "unique";
      const ids = rows.map((r) => r.key.subarray(rowPrefix.length));
      const ownerKeys = unique ? derived.flatMap((d) => (Array.isArray(d) ? d.map((e) => e.key) : [])) : [];
      const out = await this.kv.update(
        [CATALOG_KEY, ...rows.map((r) => r.key), ...ownerKeys],
        ([catalog, ...values], tx): Violation | typeof RETRY | undefined => {
          if (!bytesEqual(catalog, bound.bytes)) {
            this.adopt(catalog);
            return RETRY;
          }
          if (rows.some((r, i) => !bytesEqual(values[i], r.value))) return RETRY;
          const puts: Entry[] = [];
          const claimed = new Map<string, Uint8Array>();
          let owners = rows.length;
          for (let i = 0; i < rows.length; i++) {
            const entries = derived[i]!;
            const at = owners;
            if (unique && Array.isArray(entries)) owners += entries.length;
            const id = ids[i]!;
            if (!Array.isArray(entries)) return { reason: "value", ids: [fromUtf8.decode(id)] };
            for (let j = 0; j < entries.length; j++) {
              const e = entries[j]!;
              if (unique) {
                const k = keyString(e.key);
                const owner = values[at + j] ?? claimed.get(k);
                if (owner && !bytesEqual(owner, id)) return { reason: "unique", ids: [fromUtf8.decode(id), fromUtf8.decode(owner)] };
                claimed.set(k, id);
              }
              puts.push(e);
            }
          }
          for (const e of puts) tx.put(e.key, e.value);
          return undefined;
        },
      );
      if (out === RETRY) continue;
      if (out) {
        await this.editCatalog((c) => markFailed(c, collection, index, out.reason, out.ids));
        this.startJobs();
        return;
      }
      from = rows.at(-1)!.key;
    }
  }

  private async sweep(p: DroppedPrefix): Promise<void> {
    const collection = p.collection as CollectionId;
    const prefix = "index" in p ? indexPrefix(collection, p.index as IndexId) : collectionPrefix(collection);
    // Not `upperOf`: index id 255 is `64 CC CC FF`, which `upperOf(64 CC CC)` would exclude.
    const bounds = prefixBound(prefix);
    for (let start = prefix; ; ) {
      const keys: Uint8Array[] = [];
      for await (const e of this.kv.range({ ...bounds, start, limit: SWEEP_KEYS })) keys.push(e.key);
      if (keys.length === 0) {
        await this.editCatalog((c) => removeDropped(c, p));
        return;
      }
      await this.kv.batch((tx) => {
        for (const k of keys) tx.delete(k);
      });
      start = after(keys.at(-1)!);
    }
  }
}
