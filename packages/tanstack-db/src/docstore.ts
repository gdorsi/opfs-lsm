import type { Collection, CollectionChange, DocChange, JsonDoc } from "@opfs-lsm/docstore";
import { ClosedError } from "@opfs-lsm/kv";
import { and, compileSingleRowExpression, toBooleanPredicate, withCollectionConfigFactory } from "@tanstack/db";
import type {
  BaseCollectionConfig,
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  IR,
  LoadSubsetOptions,
  PendingMutation,
  SyncConfig,
  UtilsRecord,
} from "@tanstack/db";
import { conjuncts, planLoad, type Plan } from "./plan.js";
import { atOrBefore, read, type Boundary, type Snapshot } from "./read.js";

/**
 * A TanStack collection config without the parts this adapter owns: it keys
 * rows by their `id`, persists every mutation itself and takes the sync mode
 * from `syncMode`.
 */
export interface DocstoreCollectionConfig<T extends JsonDoc, Ix>
  extends Omit<
    BaseCollectionConfig<T, string, never>,
    "getKey" | "onInsert" | "onUpdate" | "onDelete" | "syncMode" | "utils" | "schema"
  > {
  /** A docstore collection. The caller owns its kv handle and DocStore, and many TanStack collections can share them. */
  collection: Collection<T, Ix>;
  /**
   * `"eager"` (the default) loads every document on start. `"on-demand"`
   * loads only what live queries ask for, read through the collection's
   * indexes.
   */
  syncMode?: "eager" | "on-demand";
}

export interface DocstoreCollectionUtils<T extends JsonDoc = JsonDoc> extends UtilsRecord {
  /**
   * Persist a manual transaction's mutations of this collection in one kv
   * transaction. Call it from `createTransaction({ mutationFn })`.
   */
  acceptMutations(transaction: { mutations: ReadonlyArray<PendingMutation<any>> }): Promise<void>;
  /**
   * Read `ids` and write them in one kv transaction, so no other write lands
   * between the read and the write, from this tab or another. `merge` gets the
   * stored documents in the order of `ids` (undefined = absent) and returns one
   * entry per id: a document to store, `null` to delete, `undefined` to leave
   * as is. `merge` may run more than once, the first time on what this tab
   * last saw, so it must be pure and accept any stored state. Resolves once
   * this collection shows the write, when it will show it: always for an eager
   * collection, and for an on-demand one when a loaded query keeps the
   * document. Rejects with DocStoreError "document", writing nothing, when
   * `merge` returns the wrong number of entries or a document under another id.
   */
  transact(
    ids: readonly string[],
    merge: (docs: ReadonlyArray<T | undefined>) => ReadonlyArray<T | null | undefined>,
  ): Promise<void>;
}

type Options<T extends JsonDoc> = CollectionConfig<T, string, never, DocstoreCollectionUtils<T>> & {
  id: string;
  utils: DocstoreCollectionUtils<T>;
  schema?: never;
};

export function docstoreCollectionOptions<T extends JsonDoc, Ix>(config: DocstoreCollectionConfig<T, Ix>): Options<T> {
  const { collection, syncMode = "eager", ...base } = config;
  const docs = collection as unknown as Collection<JsonDoc, unknown>;
  const id = base.id ?? `opfs-lsm:${collection.name}`;
  let current: Run | DemandRun | undefined;
  let owner: unknown;

  const sync: SyncConfig<JsonDoc, string>["sync"] = (params) => {
    owner = params.collection;
    const run = syncMode === "on-demand" ? new DemandRun(docs, params) : new Run(docs, params);
    current = run;
    run.start();
    const cleanup = () => {
      run.stop();
      if (current === run) current = undefined;
    };
    if (run instanceof Run) return cleanup;
    return { cleanup, loadSubset: (options) => run.load(options), unloadSubset: (options) => run.unload(options) };
  };

  const persist = async (mutations: ReadonlyArray<PendingMutation<any>>): Promise<void> => {
    const last = new Map<string, PendingMutation<any>>();
    for (const m of mutations) if (m.collection === owner) last.set(String(m.key), m);
    if (last.size === 0) return;
    const writes = [...last.values()];
    const deletes = writes.filter((m) => m.type === "delete");
    if (deletes.length === 0) await docs.putMany(writes.map((m) => m.modified as JsonDoc));
    else if (deletes.length === writes.length) await docs.deleteMany([...last.keys()]);
    else await docs.modifyMany([...last.keys()], () => writes.map((m) => (m.type === "delete" ? null : (m.modified as JsonDoc))));
    // docstore reported the write before it resolved, so a live run already
    // committed it. A loading run commits it with its snapshot; wait for that,
    // so the optimistic row is not dropped before the synced one shows.
    await current?.settled();
  };

  const transact: DocstoreCollectionUtils<T>["transact"] = async (ids, merge) => {
    await collection.modifyMany(ids, merge);
    await current?.settled();
  };

  const handler = ({ transaction }: { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }) =>
    persist(transaction.mutations);

  const options: Options<T> = {
    ...base,
    id,
    getKey: (doc) => doc.id,
    syncMode,
    sync: { sync: sync as unknown as SyncConfig<T, string>["sync"], rowUpdateMode: "full" },
    onInsert: handler,
    onUpdate: handler,
    onDelete: handler,
    utils: { acceptMutations: (transaction) => persist(transaction.mutations), transact },
  };
  // This object holds one collection's run, so each DbClient gets its own.
  return withCollectionConfigFactory(options, () => docstoreCollectionOptions({ ...config, id }));
}

type Docs = Collection<JsonDoc, unknown>;
type SyncParams = Parameters<SyncConfig<JsonDoc, string>["sync"]>[0];
type Append = Extract<CollectionChange<JsonDoc>, { kind: "append" }>;
type Message = ChangeMessageOrDeleteKeyMessage<JsonDoc, string>;

type Loading = { readonly kind: "loading"; readonly buffer: Append[]; readonly done: PromiseWithResolvers<void> };
type Phase = Loading | { readonly kind: "live" } | { readonly kind: "stopped" };

/** Eager: every document, read from one snapshot, then the change feed. */
class Run {
  private phase: Phase = { kind: "stopped" };
  private syncedThrough = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly docs: Docs,
    private readonly p: SyncParams,
  ) {}

  start(): void {
    try {
      this.unsubscribe = this.docs.changes((event) => this.onChange(event));
    } catch (err) {
      this.p.fail(err);
      return;
    }
    this.load();
  }

  stop(): void {
    const was = this.phase;
    this.phase = { kind: "stopped" };
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (was.kind === "loading") was.done.resolve();
  }

  settled(): Promise<void> {
    return this.phase.kind === "loading" ? this.phase.done.promise : Promise.resolve();
  }

  private onChange(event: CollectionChange<JsonDoc>): void {
    switch (event.kind) {
      case "append":
        if (this.phase.kind === "loading") this.phase.buffer.push(event);
        else if (this.phase.kind === "live" && event.seq > this.syncedThrough) this.commit(undefined, [event]);
        return;
      case "gap":
        if (this.phase.kind !== "stopped") this.load();
        return;
      case "closed":
        this.stop();
        this.p.fail(new ClosedError("database is closed"));
        return;
    }
  }

  /** A snapshot replaces the synced rows, so the first load, a gap and a restarted run all read the same way. */
  private load(): void {
    const prev = this.phase.kind === "loading" ? this.phase : undefined;
    const mine: Loading = { kind: "loading", buffer: prev?.buffer ?? [], done: prev?.done ?? Promise.withResolvers() };
    this.phase = mine;
    void this.docs.view(async (snap) => ({ at: snap.seq, docs: (await snap.query({})).docs })).then(
      (snapshot) => {
        if (this.phase !== mine) return;
        this.commit(
          snapshot,
          mine.buffer.filter((e) => e.seq > snapshot.at),
        );
        if (this.phase !== mine) return;
        this.phase = { kind: "live" };
        this.p.markReady();
        mine.done.resolve();
      },
      (err: unknown) => {
        if (this.phase !== mine) return;
        this.stop();
        this.p.fail(err);
      },
    );
  }

  private commit(snapshot: { readonly at: number; readonly docs: readonly JsonDoc[] } | undefined, events: readonly Append[]): void {
    try {
      const writes: Message[] = [];
      for (const doc of snapshot?.docs ?? []) writes.push({ type: "update", value: doc });
      for (const event of events) {
        for (const c of event.changes) writes.push(c.deleted ? { type: "delete", key: c.id } : { type: "update", value: c.doc! });
      }
      if (snapshot || writes.length > 0) {
        this.p.begin(snapshot ? { snapshot: true } : undefined);
        for (const write of writes) this.p.write(write);
        this.p.commit();
      }
    } catch (err) {
      this.stop();
      this.p.fail(err);
      return;
    }
    this.syncedThrough = Math.max(this.syncedThrough, snapshot?.at ?? 0, events.at(-1)?.seq ?? 0);
  }
}

type Match = (doc: JsonDoc) => boolean;

/** Reads in flight from one snapshot. The events that arrive meanwhile are replayed once it lands. */
type Load = { readonly buffer: Append[]; readonly done: PromiseWithResolvers<void> };

type DemandState =
  | { readonly kind: "loading"; readonly load: Load }
  | { readonly kind: "loaded"; readonly at: number; readonly boundary: Boundary | undefined }
  | { readonly kind: "released" };

/**
 * One `loadSubset` request. While it lives, it keeps the rows that pass
 * `match` in memory, following writes. A loaded ordered demand with a
 * boundary keeps only the rows at or before it.
 */
type Demand = {
  readonly options: LoadSubsetOptions;
  readonly match: Match;
  readonly reads: readonly { readonly plan: Plan; readonly match: Match }[];
  state: DemandState;
};

/** A row TanStack holds, and the seq of the state it holds. Changes at or below that seq are already in it. */
type Synced = { readonly seq: number; readonly doc: JsonDoc };

type DemandPhase =
  | {
      readonly kind: "live";
      readonly demands: Map<LoadSubsetOptions, Demand>;
      readonly synced: Map<string, Synced>;
      readonly loads: Set<Load>;
    }
  | { readonly kind: "stopped" };

/** The sync writes of one TanStack transaction, applied to `synced` as they are made. */
class Batch {
  readonly messages: Message[] = [];
  constructor(private readonly synced: Map<string, Synced>) {}

  put(doc: JsonDoc, seq: number): void {
    this.synced.set(doc.id, { seq, doc });
    this.messages.push({ type: "update", value: doc });
  }

  /** A delete of a row TanStack does not hold would name a key it does not know, so it is dropped. */
  remove(id: string): void {
    if (this.synced.delete(id)) this.messages.push({ type: "delete", key: id });
  }
}

/** On-demand: the rows live queries ask for, read through the collection's indexes. */
class DemandRun {
  private phase: DemandPhase = { kind: "stopped" };
  private unsubscribe: (() => void) | undefined;
  /** Fetches whose promise has not settled. */
  private unsettled = 0;
  /** Whether a change was committed while some fetch was unsettled. */
  private changedMidLoad = false;

  constructor(
    private readonly docs: Docs,
    private readonly p: SyncParams,
  ) {}

  start(): void {
    try {
      this.unsubscribe = this.docs.changes((event) => this.onChange(event));
    } catch (err) {
      this.p.fail(err);
      return;
    }
    this.phase = { kind: "live", demands: new Map(), synced: new Map(), loads: new Set() };
    this.p.markReady();
  }

  stop(): void {
    const was = this.phase;
    this.phase = { kind: "stopped" };
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (was.kind === "stopped") return;
    for (const load of was.loads) load.done.resolve();
  }

  /** Every change is applied as it arrives, so a write shows without waiting for a load. */
  settled(): Promise<void> {
    return Promise.resolve();
  }

  load(options: LoadSubsetOptions): Promise<void> {
    if (this.phase.kind === "stopped") return Promise.reject(new Error("the sync run has stopped"));
    let demand: Demand;
    try {
      demand = {
        options,
        match: compile(options.where),
        reads: planLoad(options, this.docs.indexes).map((r) => ({ plan: r.plan, match: compile(r.where) })),
        state: { kind: "released" },
      };
    } catch (err) {
      return Promise.reject(err);
    }
    const replaced = this.phase.demands.get(options);
    if (replaced) replaced.state = { kind: "released" };
    this.phase.demands.set(options, demand);
    return this.fetch([demand], false);
  }

  unload(options: LoadSubsetOptions): void {
    if (this.phase.kind === "stopped") return;
    const { demands, synced } = this.phase;
    const demand = demands.get(options);
    if (!demand) return;
    demands.delete(options);
    demand.state = { kind: "released" };
    const batch = new Batch(synced);
    for (const [id, row] of synced) if (!this.wants(row.doc)) batch.remove(id);
    this.apply(batch);
  }

  private onChange(event: CollectionChange<JsonDoc>): void {
    if (this.phase.kind === "stopped") return;
    switch (event.kind) {
      case "append": {
        for (const load of this.phase.loads) load.buffer.push(event);
        const batch = new Batch(this.phase.synced);
        for (const change of event.changes) this.decide(batch, change, event.seq);
        this.apply(batch);
        return;
      }
      case "gap":
        // Writes may have been missed: read every demand again, and every row TanStack holds.
        void this.fetch([...this.phase.demands.values()], true).catch(() => undefined);
        return;
      case "closed":
        this.stop();
        this.p.fail(new ClosedError("database is closed"));
        return;
    }
  }

  /**
   * Whether some live demand keeps a row. A loading demand keeps every row it
   * matches; a loaded one the rows at or before its boundary, so a row that
   * moves past every boundary leaves memory. TanStack fills a window from the
   * rows it holds, and a row past the boundary may sort after a row no load
   * returned. For a row TanStack does not hold, `seq` skips the demands
   * whose snapshot already decided on it.
   */
  private wants(doc: JsonDoc, seq?: number): boolean {
    if (this.phase.kind === "stopped") return false;
    for (const d of this.phase.demands.values()) {
      if (d.state.kind === "released" || !d.match(doc)) continue;
      if (d.state.kind === "loading") return true;
      if (seq !== undefined && seq <= d.state.at) continue;
      if (!d.state.boundary || atOrBefore(doc, d.state.boundary)) return true;
    }
    return false;
  }

  private decide(batch: Batch, change: DocChange<JsonDoc>, seq: number): void {
    if (this.phase.kind === "stopped") return;
    const row = this.phase.synced.get(change.id);
    if (row ? row.seq >= seq : this.phase.demands.size === 0) return;
    if (change.deleted) return batch.remove(change.id);
    const doc = change.doc!;
    if (this.wants(doc, row ? undefined : seq)) batch.put(doc, seq);
    else batch.remove(change.id);
  }

  /**
   * Read `demands` from one snapshot and commit their rows. With `resync`,
   * also read every row TanStack holds, which drops the rows deleted or
   * moved out of every demand meanwhile. A demand that a later fetch took
   * over is left to it, and this fetch resolves once that one does.
   */
  private fetch(demands: readonly Demand[], resync: boolean): Promise<void> {
    if (this.phase.kind === "stopped") return Promise.resolve();
    const { loads, synced } = this.phase;
    const load: Load = { buffer: [], done: Promise.withResolvers() };
    loads.add(load);
    this.unsettled++;
    void load.done.promise.then(this.settle, this.settle);
    for (const d of demands) d.state = { kind: "loading", load };
    const held = resync ? [...synced.keys()] : [];
    void this.docs
      .view(async (raw) => {
        const snap: Snapshot = raw;
        const found = await Promise.all(demands.map((d) => readDemand(snap, d)));
        return { at: raw.seq, found, current: resync ? await snap.getMany(held) : [] };
      })
      .then(({ at, found, current }) => {
        loads.delete(load);
        if (this.phase.kind === "stopped") return;
        const mine = demands.flatMap((d, i) => (d.state.kind === "loading" && d.state.load === load ? [i] : []));
        const later = demands.flatMap((d) => (d.state.kind === "loading" && d.state.load !== load ? [d.state.load.done.promise] : []));
        const batch = new Batch(synced);
        for (const i of mine) {
          demands[i]!.state = { kind: "loaded", at, boundary: found[i]!.boundary };
          for (const doc of found[i]!.docs) if ((synced.get(doc.id)?.seq ?? -1) < at) batch.put(doc, at);
        }
        held.forEach((id, i) => {
          if ((synced.get(id)?.seq ?? Infinity) >= at) return;
          const doc = current[i];
          if (doc && this.wants(doc)) batch.put(doc, at);
          else batch.remove(id);
        });
        const loaded = batch.messages.length;
        for (const event of load.buffer) for (const change of event.changes) this.decide(batch, change, event.seq);
        for (const [id, row] of synced) if (!this.wants(row.doc)) batch.remove(id);
        if (batch.messages.length > loaded) this.changedMidLoad = true;
        const receipt = this.commit(batch);
        load.done.resolve(Promise.all([receipt, ...later]).then(() => undefined));
        if (resync) void Promise.resolve(receipt).then(() => this.p.invalidateLoadedSubsets());
      })
      .catch((err: unknown) => {
        loads.delete(load);
        if (this.phase.kind === "live") {
          for (const d of demands) {
            if (d.state.kind !== "loading" || d.state.load !== load) continue;
            d.state = { kind: "released" };
            if (this.phase.demands.get(d.options) === d) this.phase.demands.delete(d.options);
          }
        }
        load.done.reject(err);
      });
    return load.done.promise;
  }

  /**
   * TanStack does not ask for more rows after a change that lands while one
   * of its loads is pending, so a window that change shortened stays short.
   * Invalidating the loaded subsets once every fetch settles makes each
   * ordered query repair its window.
   */
  private readonly settle = (): void => {
    if (--this.unsettled > 0 || !this.changedMidLoad) return;
    this.changedMidLoad = false;
    if (this.phase.kind === "live") this.p.invalidateLoadedSubsets();
  };

  private apply(batch: Batch): void {
    if (batch.messages.length > 0 && this.unsettled > 0) this.changedMidLoad = true;
    try {
      this.commit(batch);
    } catch (err) {
      this.stop();
      this.p.fail(err);
    }
  }

  private commit(batch: Batch): true | Promise<void> {
    if (batch.messages.length === 0) return true;
    this.p.begin();
    for (const message of batch.messages) this.p.write(message);
    return this.p.commit();
  }
}

/** Every read of a demand from one snapshot. Only the first read can be limited, so it alone sets the boundary. */
async function readDemand(snap: Snapshot, demand: Demand): Promise<{ docs: JsonDoc[]; boundary: Boundary | undefined }> {
  const found = await Promise.all(demand.reads.map((r) => read(snap, r.plan, r.match)));
  const byId = new Map<string, JsonDoc>();
  for (const f of found) for (const doc of f.docs) byId.set(doc.id, doc);
  return { docs: [...byId.values()], boundary: found[0]?.boundary };
}

/**
 * The `where` as a predicate on stored documents. A conjunct on one of
 * TanStack's virtual `$` properties has no value in a stored document, so
 * it is left out and the predicate may keep more rows, never fewer.
 */
function compile(where: IR.BasicExpression<boolean> | undefined): Match {
  const kept = conjuncts(where).filter((c) => !readsVirtual(c));
  if (kept.length === 0) return () => true;
  const evaluate = compileSingleRowExpression(kept.reduce((a, b) => and(a, b)));
  return (doc) => toBooleanPredicate(evaluate(doc));
}

function readsVirtual(e: IR.BasicExpression): boolean {
  if (e.type === "func") return e.args.some(readsVirtual);
  if (e.type !== "ref") return false;
  const own = e.sourceAlias !== undefined && e.path[0] === e.sourceAlias ? e.path.slice(1) : e.path;
  return own[0]?.startsWith("$") ?? false;
}
