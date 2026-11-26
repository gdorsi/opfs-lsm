import { prefixBound, type BatchTx, type ChangeEvent, type Db, type Entry, type ViewSnapshot } from "@opfs-lsm/kv";
import { tupleBounds } from "@opfs-lsm/kv/tuple";
import {
  bind,
  clearCollection,
  describeIndexes,
  encodeCatalog,
  normalizeSchema,
  parseCatalog,
  reconcile,
  sameCatalog,
  settleIndex,
  type Bound,
  type BoundCollection,
  type DeclaredSchema,
  type Edit,
  type IndexPlan,
  type StoredCatalog,
} from "./catalog.js";
import { CollectionImpl, RETRY, type Collection } from "./collection.js";
import { decodeDoc, docEncoder, indexEntries, type Unindexable } from "./derive.js";
import { DocStoreError } from "./errors.js";
import { CATALOG_KEY, after, bytesEqual, idOf, keyString, touches, type CollectionId, type IndexId } from "./keys.js";
import type { CollectionName, DocOf, IndexInfo, IndexesOf, InputOf, Schema } from "./schema.js";

export interface DocStore<S extends Schema> {
  /** A typed handle. Operations on a collection the stored catalog lacks throw "schema". */
  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>, InputOf<S, C>>;
  /** Resolves when this handle's background backfills have finished. */
  whenIdle(): Promise<void>;
}

/**
 * Bring the stored catalog in line with `schema` and return the store. Open
 * waits for the indexes `schema` declares, so each is ready or failed once
 * it resolves. The caller owns `kv`: it opened it and closes it, and keeps
 * using it for `changes`, `ingest` and other layers. Keys starting with
 * 0x64 belong to this package.
 */
export async function openDocStore<S extends Schema>(kv: Db, schema: S): Promise<DocStore<S>> {
  const declared = normalizeSchema(schema);
  // A plain read first: the readwrite transaction runs only when the catalog has to change.
  const read = await kv.get(CATALOG_KEY);
  let known: { bytes: Uint8Array; catalog: StoredCatalog } | undefined;
  try {
    const readCatalog = read && parseCatalog(read);
    if (readCatalog && !reconcile(readCatalog, declared)) known = { bytes: read!, catalog: readCatalog };
  } catch {
    // The read can lag another tab's catalog write: the transaction, at the head, throws for good.
  }
  const { bytes, catalog } =
    known ??
    (await kv.update([CATALOG_KEY], ([stored], tx) => {
      const current = stored && parseCatalog(stored);
      const next = reconcile(current, declared);
      if (!next) return { bytes: stored!, catalog: current! };
      return { bytes: storeEdit(tx, next), catalog: next.catalog };
    }));
  const store = new DocStoreImpl<S>(kv, declared, bind(bytes, catalog, declared), schema.collections);
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
  /** The collection in the catalog that `snap` holds. A promise only when the catalog has to be read. */
  collectionAt(snap: ViewSnapshot, name: string): BoundCollection | Promise<BoundCollection>;
  /** One kv `update`, planned against this handle's catalog and planned again whenever the stored catalog differs. */
  write<R>(name: string, planner: (coll: BoundCollection) => WritePlan<R> | Promise<WritePlan<R>>): Promise<R>;
  clear(name: string): Promise<void>;
}

const BACKFILL_ROWS = 500;
const BACKFILL_OPS = 8_000;
const BACKFILL_BYTES = 4 * 1024 * 1024;
/** What kv's batch limit counts for an op besides its key and value. */
const OP_BYTES = 256;
/** kv's batch limit, counting keys, values, and `OP_BYTES` per op. */
const KV_BATCH_BYTES = 8 * 1024 * 1024;
const TOO_LARGE: Unindexable = { path: "", why: "entries-too-large" };

type Violation = { readonly reason: "unique" | "value"; readonly ids: readonly string[] };

function collectionOf(bound: Bound, name: string): BoundCollection {
  const coll = bound.collections.get(name);
  if (!coll) throw new DocStoreError("schema", `the stored catalog has no collection "${name}"`);
  return coll;
}

const NO_CATALOG = new Uint8Array(0);

/** Write `edit` into `tx`: the catalog, then a range delete for each prefix it drops. Returns the catalog's bytes. */
function storeEdit(tx: BatchTx, edit: Edit): Uint8Array {
  const bytes = encodeCatalog(edit.catalog);
  tx.put(CATALOG_KEY, bytes);
  // Not `tupleBounds`: index id 255 is `64 CC CC FF`, which `tupleBounds(64 CC CC)` would exclude.
  for (const prefix of edit.drop) tx.deleteRange(prefixBound(prefix));
  return bytes;
}

const backfillKey = (coll: BoundCollection, plan: IndexPlan) => `backfill ${coll.id} ${plan.id}`;

/** The collection and the plan of an index while it is building. By ids, as `settleIndex` names it. */
function building(bound: Bound, collection: CollectionId, index: IndexId): { readonly coll: BoundCollection; readonly plan: IndexPlan } | undefined {
  for (const coll of bound.collections.values()) {
    if (coll.id !== collection) continue;
    const plan = coll.maintained.find((p) => p.id === index);
    return plan?.state.kind === "building" ? { coll, plan } : undefined;
  }
  return undefined;
}

class DocStoreImpl<S extends Schema> implements DocStore<S>, StoreCore {
  private readonly jobs = new Map<string, Promise<void>>();
  /** What each declared collection's handle reports as `indexes`. */
  private readonly indexInfo: ReadonlyMap<string, ReadonlyMap<string, IndexInfo>>;
  /**
   * The kv seq whose state has `bound` as its catalog, or NaN when none is
   * known, as at open, whose catalog read has no seq. A handle reads one
   * state at each seq, so a snapshot at this seq needs no catalog read. kv
   * can read a record before it announces it, so a snapshot past this seq
   * reads its own catalog.
   */
  private syncedAt = NaN;
  /** Counts the calls of `move`, so a read can tell that none ran while it waited. */
  private moves = 0;

  constructor(
    readonly kv: Db,
    private readonly declared: DeclaredSchema,
    private bound: Bound,
    private readonly decls: Schema["collections"],
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

  /** The one place `bound` and `syncedAt` change, so they always change together. */
  private move(bound: Bound, syncedAt: number): void {
    this.bound = bound;
    this.syncedAt = syncedAt;
    this.moves++;
  }

  /** Move along the records kv announces. */
  private follow(event: ChangeEvent): void {
    // The catalog may have changed in records that kv never announced.
    if (event.kind === "gap") this.move(this.bound, NaN);
    // A read ahead of the feed bound a state that already holds a record at or below `syncedAt`.
    if (event.kind !== "append" || event.seq <= this.syncedAt) return;
    // A record with no catalog op has the catalog of the seq before it.
    let next = event.seq === this.syncedAt + 1 ? this.bound : undefined;
    for (const op of event.ops) {
      if (op.type === "deleteRange") {
        if (touches(op, CATALOG_KEY)) next = undefined;
        continue;
      }
      if (!bytesEqual(op.key, CATALOG_KEY)) continue;
      try {
        // Copied: the bytes are a view of a memtable chunk, which `bound` would keep alive.
        next = this.boundIn(op.type === "put" ? op.value.slice() : undefined);
      } catch {
        // A catalog this library cannot read: the read that meets it throws.
        next = undefined;
      }
    }
    this.move(next ?? this.bound, next ? event.seq : NaN);
  }

  collection<C extends CollectionName<S>>(name: C): Collection<DocOf<S, C>, IndexesOf<S, C>, InputOf<S, C>> {
    const encode = docEncoder(name, this.decls[name]?.validator);
    return new CollectionImpl(this, name, this.indexInfo.get(name) ?? new Map(), encode);
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

  collectionAt(snap: ViewSnapshot, name: string): BoundCollection | Promise<BoundCollection> {
    return snap.seq === this.syncedAt ? collectionOf(this.bound, name) : this.readCatalog(snap, name);
  }

  private async readCatalog(snap: ViewSnapshot, name: string): Promise<BoundCollection> {
    const moves = this.moves;
    // Read where it is stored: the catalog is nearly always the one already bound.
    const [read] = await snap.getMany([CATALOG_KEY], (bytes) =>
      sameCatalog(bytes, this.bound.bytes) ? this.bound : this.boundIn(bytes.slice()),
    );
    const bound = read ?? this.boundIn(undefined);
    // The store stood still since the snapshot was taken, so it holds no catalog newer than this one.
    if (moves === this.moves) this.move(bound, snap.seq);
    return collectionOf(bound, name);
  }

  async write<R>(name: string, planner: (coll: BoundCollection) => WritePlan<R> | Promise<WritePlan<R>>): Promise<R> {
    for (let synced = false; ; ) {
      const bound = this.bound;
      let plan: WritePlan<R>;
      try {
        plan = await planner(collectionOf(bound, name));
      } catch (err) {
        // The planner reads this handle's state, which can lag another tab's write: its error holds once it has read every write acked before the call.
        if (synced) throw err;
        await this.kv.sync();
        // A catalog write that a flush folded reaches the feed as a gap, which does not say what it wrote.
        this.adopt(await this.kv.get(CATALOG_KEY));
        synced = true;
        continue;
      }
      const out = await this.kv.update([CATALOG_KEY, ...plan.keys], ([catalog, ...values], tx) => {
        if (!catalog) {
          storeEdit(tx, reconcile(undefined, this.declared)!);
          return RETRY;
        }
        if (!sameCatalog(catalog, bound.bytes)) {
          this.adopt(catalog);
          return RETRY;
        }
        return plan.apply(values, tx);
      });
      if (out !== RETRY) return out;
    }
  }

  /**
   * The range delete goes in the batch that writes the catalog, so no write
   * commits against the old catalog after it, and a backfill of the
   * collection retries, then finds its index ready.
   */
  clear(name: string): Promise<void> {
    return this.editCatalog((c) => clearCollection(c, name));
  }

  /**
   * Apply a transition in one `update([CATALOG_KEY])`. Transitions return
   * undefined once applied, so a repeat writes nothing. `bound` holds the
   * result once this resolves: kv announces a write before it resolves it
   * (the contract on kv's `ChangeEvent`), and `follow` binds it.
   */
  private async editCatalog(edit: (c: StoredCatalog) => Edit | undefined): Promise<void> {
    await this.kv.update([CATALOG_KEY], ([stored], tx) => {
      const next = edit(this.adopt(stored).catalog);
      if (next) storeEdit(tx, next);
    });
  }

  /** The catalog `bytes` bound, or `bound` itself when it is the same catalog. Leaves `bound` alone. */
  private boundIn(bytes: Uint8Array | undefined): Bound {
    if (!bytes) return bind(NO_CATALOG, reconcile(undefined, this.declared)!.catalog, this.declared);
    return sameCatalog(bytes, this.bound.bytes) ? this.bound : bind(bytes, parseCatalog(bytes), this.declared);
  }

  /** Bind `bytes`, which a write read at the head of the log. kv does not say at which seq. */
  private adopt(bytes: Uint8Array | undefined): Bound {
    const bound = this.boundIn(bytes);
    if (bound !== this.bound) this.move(bound, NaN);
    return bound;
  }

  startJobs(): void {
    for (const coll of this.bound.collections.values()) {
      for (const plan of coll.maintained) {
        if (plan.state.kind === "building") this.job(backfillKey(coll, plan), () => this.backfill(coll.id, plan.id));
      }
    }
  }

  private job(key: string, run: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    // Start on the next task: kv's first scan copies every memtable row in its
    // bounds at once, which would otherwise run inside `openDocStore`'s call.
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
   * Each chunk commits only under the catalog it was planned against, so a
   * `clear`, which marks the index ready, makes the next chunk find it settled.
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
        let entries = indexEntries(plan, row.key.subarray(rowPrefix.length), decodeDoc(row.value));
        let size = 0;
        if (Array.isArray(entries)) for (const e of entries) size += OP_BYTES + e.key.length + e.value.length;
        // One kv batch cannot hold these entries, so no backfill step can write them.
        if (size > KV_BATCH_BYTES) {
          entries = TOO_LARGE;
          size = 0;
        }
        // Stop before the row that passes the bound: with it, the step could pass kv's batch limit.
        if (rows.length > 0 && bytes + size > BACKFILL_BYTES) break;
        rows.push(row);
        derived.push(entries);
        if (!Array.isArray(entries)) continue;
        ops += entries.length;
        bytes += size;
        if (ops >= BACKFILL_OPS) break;
      }
      if (rows.length === 0) {
        await this.editCatalog((c) => settleIndex(c, collection, index, { kind: "ready" }));
        return;
      }

      const unique = plan.target.kind === "unique";
      const ids = rows.map((r) => r.key.subarray(rowPrefix.length));
      const ownerKeys = unique ? derived.flatMap((d) => (Array.isArray(d) ? d.map((e) => e.key) : [])) : [];
      const out = await this.kv.update(
        [CATALOG_KEY, ...rows.map((r) => r.key), ...ownerKeys],
        ([catalog, ...values], tx): Violation | typeof RETRY | undefined => {
          if (!sameCatalog(catalog, bound.bytes)) {
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
        await this.editCatalog((c) => settleIndex(c, collection, index, { kind: "failed", reason: out.reason, ids: out.ids }));
        return;
      }
      from = rows.at(-1)!.key;
    }
  }
}
