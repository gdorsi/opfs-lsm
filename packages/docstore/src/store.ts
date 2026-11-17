import { CorruptDatabaseError, prefixBound, type ChangeEvent, type Db, type Entry, type UpdateTx } from "@opfs-lsm/kv";
import { tupleBounds } from "@opfs-lsm/kv/tuple";
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
import { readBases } from "./counts.js";
import { decodeDoc, indexEntries, type Unindexable } from "./derive.js";
import { DocStoreError } from "./errors.js";
import {
  CATALOG_KEY,
  after,
  bytesEqual,
  compareBytes,
  collectionPrefix,
  idOf,
  indexPrefix,
  keyString,
  type CollectionId,
  type IndexId,
} from "./keys.js";
import type { AnySchema, CollectionName, DocOf, IndexInfo, IndexesOf } from "./schema.js";

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
    const next = reconcile(current, declared);
    if (!next) return { bytes: stored!, catalog: current! };
    const out = encodeCatalog(next);
    tx.put(CATALOG_KEY, out);
    return { bytes: out, catalog: next };
  });
  const store = new DocStoreImpl<S>(kv, declared, bind(bytes, catalog, declared));
  store.startJobs();
  await store.declaredBuilds();
  return store;
}

export type WritePlan<R> = {
  /** Point keys the body reads, after CATALOG_KEY, which the store puts first. */
  readonly keys: readonly Uint8Array[];
  /** Runs inside kv's `update` with the values of `keys`, so it may run more than once. RETRY must leave `tx` empty. */
  readonly apply: (values: readonly (Uint8Array | undefined)[], tx: UpdateTx) => R | typeof RETRY;
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

type Violation = { readonly reason: "unique" | "value"; readonly ids: readonly string[] };

function collectionOf(bound: Bound, name: string): BoundCollection {
  const coll = bound.collections.get(name);
  if (!coll) throw new DocStoreError("schema", `the stored catalog has no collection "${name}"`);
  return coll;
}

const backfillKey = (coll: BoundCollection, plan: IndexPlan) => `backfill ${coll.id} ${plan.id}`;

/** The collection and plan of an index while it is building, or undefined. By ids, as catalog.ts's `withIndex`. */
function building(bound: Bound, collection: CollectionId, index: IndexId): { coll: BoundCollection; plan: IndexPlan } | undefined {
  for (const coll of bound.collections.values()) {
    if (coll.id !== collection) continue;
    const plan = coll.maintained.find((p) => p.id === index);
    return plan?.state.kind === "building" ? { coll, plan } : undefined;
  }
  return undefined;
}

class DocStoreImpl<S extends AnySchema> implements DocStore<S>, StoreCore {
  private readonly jobs = new Map<string, Promise<void>>();
  /** What each declared collection's handle reports as `indexes`. */
  private readonly indexInfo: ReadonlyMap<string, ReadonlyMap<string, IndexInfo>>;
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
    this.indexInfo = new Map([...declared.collections].map(([name, specs]) => [name, describeIndexes(specs)]));
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
    return new CollectionImpl(this, name, this.indexInfo.get(name) ?? new Map());
  }

  async whenIdle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all(this.jobs.values());
  }

  /** The jobs that build the indexes this handle declared. */
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
        if (plan.state.kind !== "building") continue;
        this.job(backfillKey(coll, plan), () =>
          plan.target.kind === "count" ? this.buildCount(coll.id, plan.id) : this.backfill(coll.id, plan.id),
        );
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
  private async backfill(collection: CollectionId, index: IndexId): Promise<void> {
    let from: Uint8Array | undefined;
    for (;;) {
      const bound = this.bound;
      const now = building(bound, collection, index);
      if (!now) return;
      const { coll, plan } = now;
      const rowPrefix = coll.rows.prefix;
      const rows: Entry[] = [];
      const derived: (Entry[] | Unindexable)[] = [];
      let ops = 0;
      let bytes = 0;
      const range = { start: from ? after(from) : rowPrefix, endExclusive: tupleBounds(rowPrefix).endExclusive, limit: BACKFILL_ROWS };
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
            const id = ids[i]!;
            if (!Array.isArray(entries)) return { reason: "value", ids: [idOf(id)] };
            const at = owners;
            if (unique) owners += entries.length;
            for (let j = 0; j < entries.length; j++) {
              const e = entries[j]!;
              if (unique) {
                const k = keyString(e.key);
                const owner = values[at + j] ?? claimed.get(k);
                if (owner && !bytesEqual(owner, id)) return { reason: "unique", ids: [idOf(id), idOf(owner)] };
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

  /**
   * Fill a building count index with the base rows of one snapshot
   * (counts.ts), then mark it ready. Each chunk of puts commits only while the
   * catalog still has this index building; an unrelated catalog change does
   * not matter, because a base row is the same from any snapshot. So any
   * handle may run it, two at once write the same bytes, and a crash restarts
   * it from the first row.
   */
  private async buildCount(collection: CollectionId, index: IndexId): Promise<void> {
    for (;;) {
      if (!building(this.bound, collection, index)) return;
      const read = await this.kv.view(async (snap) => {
        const now = building(this.adopt(await snap.get(CATALOG_KEY)), collection, index);
        return now && readBases(snap, now.plan, now.coll.rows.prefix);
      });
      if (!read) return;
      if ("unindexable" in read) {
        await this.editCatalog((c) => markFailed(c, collection, index, "value", [idOf(read.unindexable)]));
        this.startJobs();
        return;
      }
      let done = true;
      for (let at = 0; done && at < read.bases.length; at += BACKFILL_OPS) {
        const chunk = read.bases.slice(at, at + BACKFILL_OPS);
        done = await this.kv.update([CATALOG_KEY], ([catalog], tx) => {
          if (!building(this.adopt(catalog), collection, index)) return false;
          for (const b of chunk) tx.put(b.key, b.value);
          return true;
        });
      }
      if (done) {
        await this.editCatalog((c) => markReady(c, collection, index));
        return;
      }
    }
  }

  private async sweep(p: DroppedPrefix): Promise<void> {
    const collection = p.collection as CollectionId;
    const prefix = "index" in p ? indexPrefix(collection, p.index as IndexId) : collectionPrefix(collection);
    // One op: nothing reaches the prefix any more, so no later write can land in it.
    // Not `tupleBounds`: index id 255 is `64 CC CC FF`, which `tupleBounds(64 CC CC)` would exclude.
    await this.kv.batch((tx) => tx.deleteRange(prefixBound(prefix)));
    await this.editCatalog((c) => removeDropped(c, p));
  }
}
