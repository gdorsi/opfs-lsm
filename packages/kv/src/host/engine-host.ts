import { checkDbName, type DbName } from "../check.js";
import { ClosedError, codeOfError } from "../errors.js";
import { IdBWal, uningestedBytes } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { reconcile, recordEmpty, type Trusted } from "../recover.js";
import { asGeneration, GENERATION_NONE, type Generation, type Seq } from "../seq.js";
import { CountingFs, emptyIoCounters } from "../opfs/counting-fs.js";
import {
  listRuns,
  liveRuns,
  loadGeneration,
  reclaimManifests,
  reclaimRuns,
  type GenerationMeta,
} from "../store/generation.js";
import { engineMemory, recycleEngine } from "../store/engine.js";
import { levelOf } from "../store/levels.js";
import { DEFAULT_COMPACTION_MEMORY_BYTES, hostBudget, IDLE_FLUSH_MS, IDLE_FLUSH_SHARE, type HostBudget, type HostOverrides } from "./budget.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestChunk, type IngestResult } from "./ingest.js";
import { fillReserve, inspectReserve, removeReserve, step, type Reserve, type ReserveEffect, type ReserveEvent } from "./reserve.js";
import {
  unlessHeld,
  type BusMessage,
  type ClientToHost,
  type HostStats,
  type HostToClient,
  type IngestClient,
  type WatchPolicy,
} from "./protocol.js";
import { compactLock, ingestLock, layersChannel, withLock } from "../locks.js";
import { coalesced, serial } from "../turns.js";

/**
 * The database folder as it is now, or undefined when it does not exist.
 * Called at the start of every operation: `destroyDb` can remove the folder
 * and `openDb` make a new one at the same path, so the host keeps no folder
 * across operations. Must create nothing.
 */
type FsFactory = (name: DbName) => AsyncFs | undefined | Promise<AsyncFs | undefined>;

/** The two stores of one database, opened for one operation. */
type Stores = { readonly wal: IdBWal; readonly fs: CountingFs };

/** What a tab's request to the host rejects with once `destroyDb` removed the database. */
function destroyed(): ClosedError {
  return new ClosedError("database was destroyed");
}

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

/** Host counters for one database, besides the fs IO its CountingFs keeps. */
type HostCounts = {
  flushes: number;
  l0Stops: number;
  compactionSteps: number;
  foldedBytes: number;
};

/**
 * What the host knows about one database's WAL waiting for ingest. Appends
 * arrive as BroadcastChannel hints, so `pendingBytes` can drift from the
 * WAL. Every ingest reads the WAL itself, and every watch measures it again.
 */
type IngestWatch = {
  /** The smallest limit any watching tab asked for. */
  maxWalBytes: number;
  /** The smallest `compactionMemoryBytes` any watching tab asked for. */
  compactionMemoryBytes: number;
  /** The largest `reserveBytes` any watching tab asked for. 0: no reserve, and no offer. */
  reserveBytes: number;
  /** Op bytes heard or measured and not yet folded into a run. */
  pendingBytes: number;
  /**
   * The `pendingBytes` level that starts an ingest. A failure raises it by
   * `maxWalBytes`, so a retry waits for more writes instead of looping.
   */
  triggerAt: number;
  state: "idle" | "ingesting";
  /** Open tabs that asked for this watch. The bus closes at zero. */
  watchers: number;
  bus: BroadcastChannel | undefined;
  /** Fires `IDLE_FLUSH_MS` after the last row heard. */
  idle: ReturnType<typeof setTimeout> | undefined;
};

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort. It keeps one
 * `HostedDb` per database name, for as long as the host lives. It never
 * creates a database: only `openDb` does.
 */
export class EngineHost {
  private readonly dbs = new Map<DbName, HostedDb>();

  /** `overrides` replace figures of the budget, for tests that need a small flush run or no L0 stop. */
  constructor(
    private readonly fsFactory: FsFactory,
    private readonly overrides: HostOverrides = {},
  ) {}

  private db(name: string): HostedDb {
    const dbName = checkDbName(name);
    let db = this.dbs.get(dbName);
    if (!db) {
      db = new HostedDb(dbName, this.fsFactory, this.overrides);
      this.dbs.set(dbName, db);
    }
    return db;
  }

  /**
   * What this host counted for `name` since it started. `generation` and
   * `layout` describe the recorded generation; their manifest read bypasses
   * the counters.
   */
  async stats(name: string): Promise<HostStats> {
    return this.db(name).stats();
  }

  /**
   * Flush the WAL into L0 runs, then start compaction in the background.
   * With `waitForCompaction`, also wait until the levels are in shape.
   */
  async ingest(name: string, waitForCompaction = false): Promise<{ generation: Generation }> {
    return this.db(name).ingest(waitForCompaction);
  }

  /**
   * Ingest `name` on the host's own once its WAL passes `policy.maxWalBytes`,
   * with no tab asking. Reads up to `maxWalBytes` of the waiting records in the
   * background and ingests when a reopened database is already over the limit.
   * The host holds `name` to the smallest `compactionMemoryBytes` any tab passed,
   * and keeps the largest `reserveBytes`.
   */
  watch(name: string, policy: WatchPolicy): void {
    this.db(name).watch(policy);
  }

  unwatch(name: string): void {
    this.db(name).unwatch();
  }

  /** Release the reserve of `name` for a tab whose WAL append the browser refused. */
  async makeRoom(name: string): Promise<void> {
    await this.db(name).refused();
  }

  /** Record a manifest that pairs with the WAL of `name`. See `IngestClient.repair`. */
  async repair(name: string): Promise<void> {
    await this.db(name).repair();
  }

  /** Delete every record and file of `name`. See `Db.dangerousDestroy`. */
  async destroy(name: string): Promise<void> {
    await this.db(name).destroy();
  }
}

/**
 * What the host holds for one database.
 *
 * Every manifest publish runs under one exclusive section: a queue in this
 * host plus a Web Lock across hosts. Two SharedWorkers can serve one
 * database, for example two builds whose script URLs differ. A flush holds
 * it for one L0 run at a time. Compaction merges without it and holds it
 * only to install the merged run.
 *
 * It opens the WAL database and the folder for each operation, and only if
 * they exist, so an operation after `destroyDb` finds them gone and stops.
 * A database born again under the name starts its seqs and manifest
 * numbers past every one the removed one used, so `trusted` and the
 * reserve's answer never meet a reused number.
 */
class HostedDb {
  /** The fs IO of every operation, for stats. */
  private readonly io = emptyIoCounters();
  private readonly counts: HostCounts = { flushes: 0, l0Stops: 0, compactionSteps: 0, foldedBytes: 0 };
  private readonly publishTurn = serial();
  private readonly foldTurn = serial();
  /** Settles at the next compaction install, for a flush that waits on a full L0. */
  private nextInstall: { readonly settled: Promise<void>; readonly resolve: () => void } | undefined;
  private watching: IngestWatch | undefined = undefined;
  /**
   * The generation this host last published or found intact, so `reconcile`
   * checks a recorded manifest's runs once, not on every flush. A tab that
   * records another generation makes the host check again.
   */
  private trusted: Trusted = undefined;
  /** Set while `destroy` waits for the locks, so a compaction pass stops at its next step. */
  private destroying = false;
  /** What this host knows of the reserve file (docs/reserve.md). Only `step` moves it. */
  private reserve: Reserve = { kind: "unknown" };
  /** Run compaction passes until no request arrives during one. */
  private readonly compact = coalesced(() =>
    withLock(compactLock(this.name), () => this.compactPass()),
  );

  constructor(
    private readonly name: DbName,
    private readonly fsFactory: FsFactory,
    private readonly overrides: HostOverrides,
  ) {}

  private budget(): HostBudget {
    const asked = this.watching?.compactionMemoryBytes ?? DEFAULT_COMPACTION_MEMORY_BYTES;
    return { ...hostBudget(asked), ...this.overrides };
  }

  /** The folder as it is now. Every fs the host uses is counted, so stats need no hooks in ingest or compaction. */
  private async folder(): Promise<CountingFs | undefined> {
    const inner = await this.fsFactory(this.name);
    return inner && new CountingFs(inner, this.io);
  }

  /** Open the WAL database, then the folder, for one operation. Undefined when either is gone. */
  private async stores(): Promise<Stores | undefined> {
    const wal = await IdBWal.openExisting(this.name);
    if (!wal) return undefined;
    const fs = await this.folder().catch((err: unknown) => {
      wal.close();
      throw err;
    });
    if (fs) return { wal, fs };
    wal.close();
    return undefined;
  }

  /** `fn` on the stores of one operation, or `gone()` when the database is not there. */
  private async withStores<T>(fn: (stores: Stores) => Promise<T>, gone: () => T | Promise<T>): Promise<T> {
    const stores = await this.stores();
    if (!stores) return gone();
    try {
      return await fn(stores);
    } finally {
      stores.wal.close();
    }
  }

  async stats(): Promise<HostStats> {
    const stores = await this.stores();
    if (!stores) throw destroyed();
    let recorded: Generation;
    try {
      recorded = (await stores.wal.meta()).generation ?? GENERATION_NONE;
    } finally {
      stores.wal.close();
    }
    const latest = await loadGeneration(stores.fs.inner, recorded);
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of latest?.runs ?? []) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += run.bytes;
      byLevel.set(level, entry);
    }
    return structuredClone({
      fs: this.io,
      ...this.counts,
      generation: latest?.generation ?? GENERATION_NONE,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
      memory: engineMemory(),
    });
  }

  async ingest(waitForCompaction: boolean): Promise<{ generation: Generation }> {
    const { generation } = await this.fold();
    const compaction = this.compact();
    if (!waitForCompaction) {
      compaction.catch(() => undefined);
      return { generation };
    }
    await compaction;
    return {
      generation: await this.withWal(
        async (wal) => (await wal.meta()).generation ?? GENERATION_NONE,
        () => Promise.reject(destroyed()),
      ),
    };
  }

  /**
   * Fold the WAL as it stands now into L0 runs of `flushRunBytes`, oldest
   * first. One fold runs at a time, so a flush asked for during another
   * waits for it and finds its records ingested. Each run is its own
   * exclusive section, so a compaction install waits for one run, not for the
   * whole backlog. Records acked after the fold starts are left for the next
   * flush, so a steady writer cannot keep one fold going. While L0 holds
   * `l0StopRuns` runs it publishes none, and waits for compaction instead.
   * A fold that published a run tells the tabs, whoever asked for it.
   */
  private fold(): Promise<IngestResult> {
    return this.foldTurn(() => this.foldRuns());
  }

  private async foldRuns(): Promise<IngestResult> {
    const head = await this.withWal(
      async (wal) => (await wal.meta()).head,
      () => Promise.reject(destroyed()),
    );
    let foldedBytes = 0;
    let pastStop = false;
    try {
      for (;;) {
        const budget = this.budget();
        // Taken before the attempt, so an install that lands during it is not missed.
        const installed = this.installSignal();
        const chunk = await this.withRoom(() =>
          this.exclusive(() =>
            this.withStores(
              async ({ wal, fs }) => {
                const folded = await ingestChunk(wal, fs, head, this.trusted, {
                  maxBytes: budget.flushRunBytes,
                  l0Stop: pastStop ? Number.POSITIVE_INFINITY : budget.l0StopRuns,
                });
                // Skipped while a tab loads a generation; the next flush or reclaim removes them.
                await unlessHeld(this.name, () => reclaimManifests(fs, folded.generation));
                return folded;
              },
              () => Promise.reject(destroyed()),
            ),
          ),
        );
        recycleEngine(budget.wasmRecycleBytes);
        pastStop = false;
        this.trusted = chunk.generation;
        if (chunk.kind === "stopped") {
          this.counts.l0Stops += 1;
          pastStop = (await this.waitForInstall(installed)) === "idle";
          continue;
        }
        foldedBytes += chunk.foldedBytes;
        this.counts.foldedBytes += chunk.foldedBytes;
        if (chunk.kind === "folded") this.counts.flushes += 1;
        const watch = this.watching;
        if (watch) {
          watch.pendingBytes = Math.max(0, watch.pendingBytes - chunk.foldedBytes);
          watch.triggerAt = watch.maxWalBytes;
        }
        if (chunk.kind === "empty" || chunk.ingestedThrough >= head) {
          return { generation: chunk.generation, ingestedThrough: chunk.ingestedThrough, foldedBytes };
        }
      }
    } finally {
      if (foldedBytes > 0) announceGeneration(this.name);
    }
  }

  /** A promise for the next compaction install. */
  private installSignal(): Promise<void> {
    if (!this.nextInstall) {
      let resolve!: () => void;
      this.nextInstall = { settled: new Promise<void>((r) => (resolve = r)), resolve };
    }
    return this.nextInstall.settled;
  }

  private installLanded(): void {
    const next = this.nextInstall;
    this.nextInstall = undefined;
    next?.resolve();
  }

  /**
   * Wait for the install a full L0 needs, starting a compaction pass if none
   * runs. "idle" when compaction ends without one (nothing to merge, or it
   * failed): the flush then goes on, since waiting longer would wait for
   * nothing.
   */
  private async waitForInstall(installed: Promise<void>): Promise<"installed" | "idle"> {
    const ended = this.compact().then(
      () => "idle" as const,
      () => "idle" as const,
    );
    return Promise.race([installed.then(() => "installed" as const), ended]);
  }

  watch(policy: WatchPolicy): void {
    const watch = this.watching ?? this.startWatch(policy);
    watch.watchers += 1;
    watch.maxWalBytes = Math.min(watch.maxWalBytes, policy.maxWalBytes);
    watch.compactionMemoryBytes = Math.min(watch.compactionMemoryBytes, policy.compactionMemoryBytes);
    watch.reserveBytes = Math.max(watch.reserveBytes, policy.reserveBytes);
    // `destroyDb` may have removed the file since this host last looked.
    this.reserve = step(this.reserve, { kind: "watch" }).next;
    watch.triggerAt = watch.maxWalBytes;
    void this.withWal(
      (wal) => uningestedBytes(wal, watch.maxWalBytes),
      () => 0,
    ).then(
      (waiting) => {
        watch.pendingBytes = Math.max(watch.pendingBytes, waiting);
        this.maybeIngest(watch);
        this.quiet(watch);
      },
      (err: unknown) => {
        if (isClosedDatabase(err)) return;
        console.error(`opfs-lsm: reading the WAL of ${this.name} failed`, err);
      },
    );
  }

  unwatch(): void {
    const watch = this.watching;
    if (!watch || --watch.watchers > 0) return;
    watch.bus?.close();
    clearTimeout(watch.idle);
    this.watching = undefined;
    this.reserve = step(this.reserve, { kind: "last-unwatch" }).next;
  }

  private startWatch(policy: WatchPolicy): IngestWatch {
    const watch: IngestWatch = {
      maxWalBytes: policy.maxWalBytes,
      compactionMemoryBytes: policy.compactionMemoryBytes,
      reserveBytes: policy.reserveBytes,
      pendingBytes: 0,
      triggerAt: policy.maxWalBytes,
      state: "idle",
      watchers: 0,
      bus: undefined,
      idle: undefined,
    };
    if (typeof BroadcastChannel !== "undefined") {
      watch.bus = new BroadcastChannel(layersChannel(this.name));
      watch.bus.onmessage = (ev: MessageEvent<BusMessage>) => {
        const msg = ev.data;
        if (msg.kind === "rows") {
          watch.pendingBytes += msg.bytes;
          this.maybeIngest(watch);
          this.quiet(watch);
        } else if (msg.kind === "full-pull") {
          void this.onReserve({ kind: "pull" }).catch(() => undefined);
        } else if (msg.kind === "full-done") {
          void this.answered().catch(() => undefined);
        }
      };
    }
    this.watching = watch;
    return watch;
  }

  /**
   * Flush once the database has been quiet for `IDLE_FLUSH_MS`, so the next
   * open replays a short tail. Each row heard restarts the wait, and a
   * watch the last tab left gets none.
   */
  private quiet(watch: IngestWatch): void {
    clearTimeout(watch.idle);
    if (this.watching !== watch) return;
    watch.idle = setTimeout(() => {
      this.maybeIngest(watch, true);
      // No flush will end a pass on a quiet database, and the reserve is written at the end of one.
      if (watch.state === "idle" && this.reserve.kind !== "held") this.compact().catch(() => undefined);
    }, this.overrides.idleFlushMs ?? IDLE_FLUSH_MS);
  }

  /**
   * One ingest in flight per watch; it checks again when it finishes. A
   * quiet database (`idle`) flushes at a share of the limit, unless a
   * failed flush raised the trigger.
   */
  private maybeIngest(watch: IngestWatch, idle = false): void {
    const trigger =
      idle && watch.triggerAt === watch.maxWalBytes ? watch.maxWalBytes / IDLE_FLUSH_SHARE : watch.triggerAt;
    if (watch.state !== "idle" || watch.pendingBytes < trigger || this.watching !== watch) return;
    watch.state = "ingesting";
    void (async () => {
      try {
        const { foldedBytes } = await this.fold();
        // Nothing was waiting, so the count was ahead of the WAL. Without
        // this, it would stay over the trigger and ingest in a loop.
        if (foldedBytes === 0) watch.pendingBytes = 0;
        this.compact().catch(() => undefined);
      } catch (err) {
        // A database `destroyDb` removed is not a failure.
        if (!(err instanceof ClosedError)) console.error(`opfs-lsm: ingest of ${this.name} failed`, err);
        watch.triggerAt = watch.pendingBytes + watch.maxWalBytes;
      } finally {
        watch.state = "idle";
      }
      this.maybeIngest(watch);
      // What arrived during the ingest waits for the next quiet stretch.
      this.quiet(watch);
    })();
  }

  /**
   * Empty the database, then remove the files no tab holds
   * (design.md, "Emptying"). `dangerousDestroy` only: the storage
   * stays. Holds the compaction and ingest locks, so no flush or merge
   * publishes meanwhile, and a merge running when it is called stops
   * after its current step. `recordEmpty` is the commit point. Tabs
   * follow it like any new generation, and the runs a tab still holds
   * go once it lets go, at a later reclaim.
   */
  async destroy(): Promise<void> {
    this.destroying = true;
    try {
      await withLock(compactLock(this.name), () =>
        this.exclusive(() =>
          this.withStores(
            async ({ wal, fs }) => {
              await recordEmpty(wal, fs, undefined);
              this.trusted = GENERATION_NONE;
              if (this.watching) this.watching.pendingBytes = 0;
              await unlessHeld(this.name, () => reclaimManifests(fs, asGeneration(Number.POSITIVE_INFINITY)));
              await this.reclaim(fs, wal);
            },
            () => Promise.reject(destroyed()),
          ),
        ),
      );
    } finally {
      this.destroying = false;
      announceGeneration(this.name);
    }
  }

  /**
   * `reconcile` for a tab, with no generation trusted: the tab asks because
   * the recorded one did not load, or because its open found a manifest to
   * adopt.
   */
  async repair(): Promise<void> {
    await this.exclusive(() =>
      this.withStores(
        async ({ wal, fs }) => {
          this.trusted = (await reconcile(wal, fs, undefined)).generation;
        },
        () => Promise.reject(destroyed()),
      ),
    );
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.publishTurn(() => withLock(ingestLock(this.name), fn));
  }

  /** `fn` on the WAL database for one operation, or `gone()` when it does not exist. */
  private async withWal<T>(fn: (wal: IdBWal) => Promise<T>, gone: () => T | Promise<T>): Promise<T> {
    const wal = await IdBWal.openExisting(this.name);
    if (!wal) return gone();
    try {
      return await fn(wal);
    } finally {
      wal.close();
    }
  }

  /**
   * Resolves the folder once: the pass holds the compaction lock throughout,
   * and `destroyDb` takes it before it removes the folder. Each step opens
   * the WAL database again, and the pass stops quietly once it is gone.
   */
  private async compactPass(): Promise<void> {
    const fs = await this.folder();
    if (!fs) return;
    let installed = false;
    let steps = 0;
    try {
      for (let i = 0; i < MAX_COMPACTION_STEPS && !this.destroying; i++) {
        const meta = await this.withWal((wal) => wal.meta(), () => undefined);
        if (!meta) return;
        const base = await loadGeneration(fs, meta.generation ?? GENERATION_NONE);
        // Gone when a flush installed a newer generation since: plan again.
        if (!base) continue;
        const budget = this.budget();
        const merged = await this.withRoom(() => mergeNextStep(fs, budget, base, meta.top));
        recycleEngine(budget.wasmRecycleBytes);
        if (!merged) return await this.settle(base, meta.head);
        const landed = await this.withRoom(() =>
          this.exclusive(() =>
            this.withWal(
              async (wal) => {
                this.trusted = await installStep(fs, wal, merged, this.trusted);
                await this.reclaim(fs, wal);
                return true;
              },
              () => false,
            ),
          ),
        );
        if (!landed) return;
        installed = true;
        steps += 1;
        this.counts.compactionSteps += 1;
        this.installLanded();
        announceGeneration(this.name);
      }
    } finally {
      // A pass cut off at the step limit asks for another, which queues behind
      // the lock's waiters; a step that threw never reached the limit.
      if (steps === MAX_COMPACTION_STEPS && !this.destroying) this.compact().catch(() => undefined);
      // A pass that installed nothing sweeps once, for the files an earlier
      // pass had to leave. Last, so it never delays a merge that a full L0
      // waits for, and best-effort: the next pass sweeps again.
      if (!installed && !this.destroying) {
        await this.exclusive(() => this.withWal((wal) => this.sweepIdle(fs, wal), () => undefined)).catch(() => undefined);
      }
    }
  }

  /**
   * Run a write. When the browser refuses it and the reserve is released
   * for it, run it once more: a flush then resumes from `ingestedThrough`.
   */
  private async withRoom<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (codeOfError(err) !== "quota" || !(await this.refused())) throw err;
      return write();
    }
  }

  /**
   * The browser refused a write of this database, the host's or a tab's.
   * True when the reserve was released for it. Resolves once the file is
   * gone, whoever removed it.
   */
  async refused(): Promise<boolean> {
    if (!this.watching?.reserveBytes) return false;
    const head = await this.head();
    return head !== undefined && this.onReserve({ kind: "refused", head });
  }

  /**
   * A pass found `base` in shape. The reserve is written, and the handlers
   * asked again, only here: by then a flush holds what they wrote and
   * compaction has dropped what it could.
   */
  private async settle(base: GenerationMeta, head: Seq): Promise<void> {
    const watch = this.watching;
    if (!watch) return;
    try {
      await this.onReserve({ kind: "settle", through: base.through, head, target: watch.reserveBytes });
    } catch (err) {
      console.error(`opfs-lsm: writing the reserve of ${this.name} failed`, err);
    }
  }

  /** The handlers settled, so every write of theirs is at or below the head read now. */
  private async answered(): Promise<void> {
    const head = await this.head();
    if (head !== undefined) await this.onReserve({ kind: "done", head });
  }

  private head(): Promise<Seq | undefined> {
    return this.withWal(
      async (wal) => (await wal.meta()).head,
      () => undefined,
    );
  }

  /**
   * Move the reserve by `event`, then by the outcome of each effect, in one
   * exclusive section: the file has one writer at a time, across hosts, and
   * a fill never overlaps a flush. True when it released the file. An event
   * that changes nothing takes no lock, unless it is a refused write: a
   * release in flight has the state ahead of the file.
   */
  private onReserve(event: ReserveEvent): Promise<boolean> {
    const first = step(this.reserve, event);
    if (event.kind !== "refused" && first.next === this.reserve && first.effect.kind === "none") return Promise.resolve(false);
    return this.exclusive(async () => {
      const fs = await this.folder();
      if (!fs) return false;
      let released = false;
      for (let next: ReserveEvent | undefined = event; next; ) {
        const moved = step(this.reserve, next);
        this.reserve = moved.next;
        released ||= moved.effect.kind === "release";
        next = await this.act(fs, moved.effect);
      }
      return released;
    });
  }

  /** Run `effect`, and return the event that says how it went. */
  private async act(fs: AsyncFs, effect: ReserveEffect): Promise<ReserveEvent | undefined> {
    switch (effect.kind) {
      case "none":
        return undefined;
      case "inspect":
        return { kind: "found", bytes: await inspectReserve(fs), head: effect.head, target: effect.target };
      case "fill":
        return (await fillReserve(fs, effect.target)) === "ok"
          ? { kind: "filled", bytes: effect.target }
          : { kind: "fill-refused", head: effect.head };
      case "remove":
        await removeReserve(fs);
        return undefined;
      case "release":
        await removeReserve(fs);
        await this.postOffer(fs);
        return undefined;
      case "offer":
        await this.postOffer(fs);
        return undefined;
      case "flush":
        this.ingest(false).catch((err: unknown) => {
          if (!(err instanceof ClosedError)) console.error(`opfs-lsm: ingest of ${this.name} failed`, err);
        });
        return undefined;
    }
  }

  /** Tell the tabs the browser refused a write. The handle that holds the full lock answers (`Db.onStorageFull`). */
  private async postOffer(fs: AsyncFs): Promise<void> {
    const watch = this.watching;
    if (!watch?.bus) return;
    const bytes = await this.withWal(
      async (wal) => {
        const recorded = await loadGeneration(fs, (await wal.meta()).generation ?? GENERATION_NONE);
        return (recorded?.runs ?? []).reduce((n, run) => n + run.bytes, 0);
      },
      () => 0,
    ).catch(() => 0);
    const message: BusMessage = { kind: "full", full: { bytes, need: watch.reserveBytes } };
    watch.bus.postMessage(message);
  }

  /**
   * Remove the manifests older than the recorded one, and every run file
   * outside the recorded generation that no tab holds. The files to go are
   * read from the directories each time, so whatever left one behind (a
   * merged input, a crash, a failed install, another host), the next call
   * removes it. Needs the ingest and compaction locks, so no run being
   * written is mistaken for an orphan. Reconciles first: after a power loss
   * the recorded manifest can be gone, and sweeping against it would remove
   * the runs recovery needs.
   *
   * Skipped, without waiting, while a tab holds the reclaim lock to load a
   * generation (`holdingFiles`): the next pass tries again (design.md,
   * "Loading a generation under churn").
   */
  private async reclaim(fs: AsyncFs, wal: IdBWal): Promise<void> {
    await unlessHeld(this.name, async () => {
      const { generation } = await reconcile(wal, fs, this.trusted);
      this.trusted = generation;
      await sweep(fs, generation);
    });
  }

  /**
   * The sweep of a pass that installed nothing. It repairs nothing: when
   * the recorded generation is not the one this host last checked, it
   * leaves the files, the next flush reconciles, and a later pass sweeps.
   * It needs no reconcile for the one it did check: `sweep` reads that
   * manifest before it removes anything, and stops if it is gone.
   */
  private async sweepIdle(fs: AsyncFs, wal: IdBWal): Promise<void> {
    await unlessHeld(this.name, async () => {
      const generation = (await wal.meta()).generation ?? GENERATION_NONE;
      if (generation === this.trusted) await sweep(fs, generation);
    });
  }
}

/** Reads the manifest of `generation` first, so a missing one throws before any file goes. */
async function sweep(fs: AsyncFs, generation: Generation): Promise<void> {
  const live = await liveRuns(fs, generation);
  await reclaimManifests(fs, generation);
  await reclaimRuns(fs, await listRuns(fs), live);
}

/** Tell the tabs to install the new generation and drop the merged runs. */
function announceGeneration(dbName: DbName): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bus = new BroadcastChannel(layersChannel(dbName));
  const message: BusMessage = { kind: "ingest" };
  bus.postMessage(message);
  bus.close();
}

function isClosedDatabase(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "InvalidStateError"
  );
}

/** Serve EngineHost over a MessagePort (SharedWorker connection or test channel). */
export function attachEngineHostPort(
  port: MessagePort,
  host: EngineHost,
): () => void {
  const onMessage = async (ev: MessageEvent<ClientToHost>) => {
    const msg = ev.data;
    const reply = (m: HostToClient) => port.postMessage(m);
    try {
      switch (msg.type) {
        case "ingest": {
          const { generation } = await host.ingest(msg.name, msg.waitForCompaction);
          reply({ type: "ingest-ok", id: msg.id, generation });
          return;
        }
        case "watch":
          host.watch(msg.name, msg);
          return;
        case "unwatch":
          host.unwatch(msg.name);
          return;
        case "make-room":
          await host.makeRoom(msg.name);
          reply({ type: "make-room-ok", id: msg.id });
          return;
        case "stats":
          reply({ type: "stats-ok", id: msg.id, stats: await host.stats(msg.name) });
          return;
        case "repair":
          await host.repair(msg.name);
          reply({ type: "repair-ok", id: msg.id });
          return;
        case "destroy":
          await host.destroy(msg.name);
          reply({ type: "destroy-ok", id: msg.id });
          return;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg && typeof msg === "object" && "id" in msg) {
        const id = (msg as { id: number }).id;
        const code = codeOfError(err);
        reply(code ? { type: "err", id, message, code } : { type: "err", id, message });
      }
    }
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();
  return () => port.removeEventListener("message", listener);
}

export function createLocalIngestClient(host: EngineHost): IngestClient {
  return {
    ingest: (name, waitForCompaction) => host.ingest(name, waitForCompaction),
    watch: (name, policy) => host.watch(name, policy),
    unwatch: (name) => host.unwatch(name),
    makeRoom: (name) => host.makeRoom(name),
    repair: (name) => host.repair(name),
    destroy: (name) => host.destroy(name),
    stats: (name) => host.stats(name),
    close: () => undefined,
  };
}
