import { checkDbName, type DbName } from "../check.js";
import { ClosedError, codeOfError, hasErrorName, isQuota, StorageUnavailableError } from "../errors.js";
import { openExistingWal, uningestedBytes, type IdBWal, type WalMeta } from "../idb/wal.js";
import type { AsyncFs, FileWrites } from "../opfs/async-fs.js";
import { fileWrites } from "../opfs/browser-fs.js";
import { reconcile, recordEmpty, type Trusted } from "../recover.js";
import { asGeneration, GENERATION_NONE, type Generation } from "../seq.js";
import { loadGeneration } from "../store/generation.js";
import { listRuns, liveRuns, reclaimManifests, reclaimRuns } from "./reclaim.js";
import { recycleEngine } from "../store/engine.js";
import { DEFAULT_COMPACTION_MEMORY_BYTES, hostBudget, IDLE_FLUSH_DUE_MS, IDLE_FLUSH_MS, IDLE_FLUSH_SHARE, type HostBudget, type HostOverrides } from "./budget.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestChunk, type Chunk } from "./ingest.js";
import { fillReserve, inspectReserve, removeReserve, step, type Reserve, type ReserveEffect, type ReserveEvent } from "./reserve.js";
import {
  HOST_CALLS,
  type BusMessage,
  type ClientToHost,
  type HostCall,
  type HostCalls,
  type HostStats,
  type HostToClient,
  type IngestClient,
  type WatchPolicy,
} from "./protocol.js";
import { compactLock, ingestLock, layersChannel, unlessHeld, withLock } from "../locks.js";
import { coalesced, serial } from "../turns.js";

/**
 * The database folder as it is now, or undefined when it does not exist.
 * Called at the start of every operation: `destroyDb` can remove the folder
 * and `openDb` make a new one at the same path, so the host keeps no folder
 * across operations. Must create nothing.
 */
export type FsFactory = (name: DbName) => AsyncFs | undefined | Promise<AsyncFs | undefined>;

/**
 * Counts what a host does, for `readStats`. Only `@opfs-lsm/kv/testing`
 * gives one: the shipped SharedWorker has none, so no app downloads it.
 */
export type Meter = {
  /** The folder of one operation on `name`, as the host uses it. */
  fs(name: DbName, inner: AsyncFs): AsyncFs;
  /** A flush of `name` ended a chunk: it published a run, found nothing to fold, or found L0 full. */
  flushed(name: DbName, chunk: Chunk): void;
  /** A compaction step of `name` installed. */
  compacted(name: DbName): void;
};

const UNMETERED: Meter = { fs: (_name, inner) => inner, flushed() {}, compacted() {} };

/** How a host is built. */
export type HostOptions = HostOverrides & {
  /**
   * False where the host cannot write run files (design.md, "Where code
   * runs"): it folds nothing, compacts nothing and keeps no reserve, so every
   * record stays in the WAL. Default true.
   */
  readonly writes?: boolean;
};

/** The two stores of one database, opened for one operation. */
type Stores = { readonly wal: IdBWal; readonly fs: AsyncFs };

/** What a tab's request to the host rejects with once `destroyDb` removed the database. */
export function destroyed(): ClosedError {
  return new ClosedError("database was destroyed");
}

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

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
  /** Fires `IDLE_FLUSH_DUE_MS` after the first row heard since it last fired or an ingest started, however busy the database. */
  due: ReturnType<typeof setTimeout> | undefined;
};

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort. It keeps one
 * `HostedDb` per database name, for as long as the host lives. It never
 * creates a database: only `openDb` does. Its methods of `HOST_CALLS` are
 * the handlers both clients call.
 */
export class EngineHost implements HostCalls {
  private readonly dbs = new Map<DbName, HostedDb>();

  /** `overrides` may replace figures of the budget, for tests that need a small flush run or no L0 stop. */
  constructor(
    protected readonly fsFactory: FsFactory,
    private readonly overrides: HostOptions = {},
    private readonly meter: Meter = UNMETERED,
  ) {}

  private db(name: string): HostedDb {
    const dbName = checkDbName(name);
    let db = this.dbs.get(dbName);
    if (!db) {
      db = hostedDb(dbName, this.fsFactory, this.overrides, this.meter);
      this.dbs.set(dbName, db);
    }
    return db;
  }

  /** What this host counted for `name`. A host with a meter answers; this one rejects. */
  stats(_name: string): Promise<HostStats> {
    return Promise.reject(new StorageUnavailableError("this host keeps no stats"));
  }

  /**
   * Flush the WAL into L0 runs, then start compaction in the background.
   * With `waitForCompaction`, also wait until the levels are in shape. A
   * host that writes no run file flushes and compacts nothing.
   */
  async ingest(name: string, waitForCompaction = false): Promise<{ generation: Generation }> {
    return this.db(name).ingest(waitForCompaction);
  }

  /**
   * Ignored by a host that writes no run file. Otherwise:
   * ingest `name` on the host's own once its WAL passes `policy.maxWalBytes`,
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
  // fallow-ignore-next-line unused-class-member -- the clients call every host method through HOST_CALLS, which fallow cannot follow
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
 * What it holds in memory is this host's own. After another host
 * published, `trusted` names an older generation, which costs one check of
 * the recorded manifest, and `pendingBytes` counts records that host
 * folded, which costs one flush that finds nothing. The reserve's state is
 * not shared either (docs/reserve.md, "Several hosts").
 *
 * It opens the WAL database and the folder for each operation, and only if
 * they exist, so an operation after `destroyDb` finds them gone and stops.
 * A database born again under the name starts its seqs and manifest
 * numbers past every one the removed one used, so `trusted` and the
 * reserve's answer never meet a reused number.
 */
function hostedDb(name: DbName, fsFactory: FsFactory, overrides: HostOptions, meter: Meter) {
  const writes = overrides.writes !== false;
  const publishTurn = serial();
  const foldTurn = serial();
  /** A flush waits on a full L0 for the next compaction install. */
  let stopped = false;
  /** Settles at the next compaction install, for a flush that waits on a full L0. */
  let nextInstall: { readonly settled: Promise<void>; readonly resolve: () => void } | undefined;
  let watching: IngestWatch | undefined;
  /**
   * The generation this host last published or found intact, so `reconcile`
   * checks a recorded manifest's runs once, not on every flush. A tab that
   * records another generation makes the host check again.
   */
  let trusted: Trusted;
  /** Set while `destroy` waits for the locks, so a compaction pass stops at its next step. */
  let destroying = false;
  /** What this host knows of the reserve file (docs/reserve.md). Only `step` moves it. */
  let reserve: Reserve = { kind: "unknown" };
  /** Run compaction passes until no request arrives during one. */
  const compact = coalesced(() => withLock(compactLock(name), compactPass));

  function failed(what: string, err: unknown): void {
    console.error(`opfs-lsm: ${what} of ${name} failed`, err);
  }

  function currentBudget(): HostBudget {
    const asked = watching?.compactionMemoryBytes ?? DEFAULT_COMPACTION_MEMORY_BYTES;
    return { ...hostBudget(asked), ...overrides };
  }

  /** The folder as it is now. Every fs the host uses goes through the meter, so ingest and compaction need no hooks for IO. */
  async function folder(): Promise<AsyncFs | undefined> {
    const inner = await fsFactory(name);
    return inner && meter.fs(name, inner);
  }

  /** `fn` on the WAL database, then the folder, opened for one operation. Rejects when either is gone. */
  async function withStores<T>(fn: (stores: Stores) => Promise<T>): Promise<T> {
    const wal = await openExistingWal(name);
    if (!wal) throw destroyed();
    try {
      const fs = await folder();
      if (!fs) throw destroyed();
      return await fn({ wal, fs });
    } finally {
      wal.close();
    }
  }

  /**
   * A host that writes no run file answers with the recorded generation.
   * With `waitForCompaction` it first removes the files no generation
   * needs, as a compaction pass does at its end: `dangerousDestroy` asks so
   * once its tab let go of its runs, and no pass of this host follows.
   */
  async function ingest(waitForCompaction: boolean): Promise<{ generation: Generation }> {
    if (writes) {
      const generation = await fold();
      const compaction = compact();
      if (!waitForCompaction) {
        compaction.catch(() => undefined);
        return { generation };
      }
      await compaction;
    } else if (waitForCompaction) {
      await withLock(compactLock(name), async () => {
        const fs = await folder();
        if (fs) await exclusive(() => withWal((wal) => reclaim(fs, wal), () => undefined));
      });
    }
    return {
      generation: (await walMetaOrDestroyed()).generation ?? GENERATION_NONE,
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
  function fold(): Promise<Generation> {
    return foldTurn(async () => {
      const { head } = await walMetaOrDestroyed();
      // A tab posts a row once it commits, so every byte heard by now is of a seq at or below `head`.
      const watched = watching;
      const heard = watched?.pendingBytes ?? 0;
      let foldedBytes = 0;
      let pastStop = false;
      try {
        for (;;) {
          const budget = currentBudget();
          // Taken before the attempt, so an install that lands during it is not missed.
          const installed = installSignal();
          const chunk = await withRoom(() =>
            exclusive(() =>
              withStores(
                async ({ wal, fs }) => {
                  const folded = await ingestChunk(wal, fs, head, trusted, {
                    maxBytes: budget.flushRunBytes,
                    l0Stop: pastStop ? Number.POSITIVE_INFINITY : budget.l0StopRuns,
                  });
                  // Skipped while a tab loads a generation; the next flush or reclaim removes them.
                  await unlessHeld(name, () => reclaimManifests(fs, folded.generation));
                  return folded;
                },
              ),
            ),
          );
          recycleEngine(budget.wasmRecycleBytes);
          pastStop = false;
          trusted = chunk.generation;
          meter.flushed(name, chunk);
          if (chunk.kind === "stopped") {
            stopped = true;
            pastStop = (await waitForInstall(installed)) === "idle";
            stopped = false;
            continue;
          }
          foldedBytes += chunk.foldedBytes;
          const watch = watching;
          if (watch) {
            watch.pendingBytes = Math.max(0, watch.pendingBytes - chunk.foldedBytes);
            watch.triggerAt = watch.maxWalBytes;
          }
          if (chunk.kind === "empty" || chunk.ingestedThrough >= head) {
            // Nothing up to `head` was waiting, so the count was ahead of the WAL
            // by what it heard before. Without this, it would stay over the
            // trigger and ingest in a loop.
            if (foldedBytes === 0 && watched) watched.pendingBytes = Math.max(0, watched.pendingBytes - heard);
            return chunk.generation;
          }
        }
      } finally {
        if (foldedBytes > 0) announceGeneration(name);
      }
    });
  }

  /** A promise for the next compaction install. */
  function installSignal(): Promise<void> {
    if (!nextInstall) {
      let resolve!: () => void;
      nextInstall = { settled: new Promise<void>((r) => (resolve = r)), resolve };
    }
    return nextInstall.settled;
  }

  function installLanded(): void {
    const next = nextInstall;
    nextInstall = undefined;
    next?.resolve();
  }

  /**
   * Wait for the install a full L0 needs, starting a compaction pass if none
   * runs. "idle" when compaction ends without one (nothing to merge, or it
   * failed): the flush then goes on, since waiting longer would wait for
   * nothing.
   */
  async function waitForInstall(installed: Promise<void>): Promise<"installed" | "idle"> {
    const ended = compact().then(
      () => "idle" as const,
      () => "idle" as const,
    );
    return Promise.race([installed.then(() => "installed" as const), ended]);
  }

  /** Ignored by a host that writes no run file: it has nothing to flush and no reserve to keep. */
  function addWatcher(policy: WatchPolicy): void {
    if (!writes) return;
    const watch = watching ?? startWatch(policy);
    watch.watchers += 1;
    watch.maxWalBytes = Math.min(watch.maxWalBytes, policy.maxWalBytes);
    watch.compactionMemoryBytes = Math.min(watch.compactionMemoryBytes, policy.compactionMemoryBytes);
    watch.reserveBytes = Math.max(watch.reserveBytes, policy.reserveBytes);
    // `destroyDb` may have removed the file since this host last looked.
    reserve = step(reserve, { kind: "watch" }).next;
    watch.triggerAt = watch.maxWalBytes;
    void withWal(
      (wal) => uningestedBytes(wal, watch.maxWalBytes),
      () => 0,
    ).then(
      (waiting) => {
        watch.pendingBytes = Math.max(watch.pendingBytes, waiting);
        maybeIngest(watch);
        quiet(watch);
      },
      (err: unknown) => {
        // The WAL database closed under the read.
        if (hasErrorName(err, "InvalidStateError")) return;
        failed("reading the WAL", err);
      },
    );
  }

  function removeWatcher(): void {
    const watch = watching;
    if (!watch || --watch.watchers > 0) return;
    watch.bus?.close();
    clearTimeout(watch.idle);
    clearTimeout(watch.due);
    watching = undefined;
    reserve = step(reserve, { kind: "last-unwatch" }).next;
  }

  function startWatch(policy: WatchPolicy): IngestWatch {
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
      due: undefined,
    };
    if (typeof BroadcastChannel !== "undefined") {
      watch.bus = new BroadcastChannel(layersChannel(name));
      watch.bus.onmessage = (ev: MessageEvent<BusMessage>) => {
        const msg = ev.data;
        if (msg.kind === "rows") {
          watch.pendingBytes += msg.bytes;
          maybeIngest(watch);
          quiet(watch);
        } else if (msg.kind === "full-pull") {
          void onReserve({ kind: "pull" }).catch(() => undefined);
        } else if (msg.kind === "full-done") {
          void answered().catch(() => undefined);
        }
      };
    }
    watching = watch;
    return watch;
  }

  /**
   * Flush once the database has been quiet for `IDLE_FLUSH_MS`, or once a
   * row has waited `IDLE_FLUSH_DUE_MS`, so the next open replays a short
   * tail even after a writer that never paused. Each row restarts the quiet
   * wait, not the due one, and a watch the last tab left gets neither.
   */
  function quiet(watch: IngestWatch): void {
    clearTimeout(watch.idle);
    if (watching !== watch) return;
    watch.idle = setTimeout(() => {
      maybeIngest(watch, true);
      // No flush will end a pass on a quiet database, and the reserve is written at the end of one.
      if (watch.state === "idle" && reserve.kind !== "held") compact().catch(() => undefined);
    }, overrides.idleFlushMs ?? IDLE_FLUSH_MS);
    watch.due ??= setTimeout(() => {
      watch.due = undefined;
      maybeIngest(watch, true);
    }, overrides.idleFlushDueMs ?? IDLE_FLUSH_DUE_MS);
  }

  /**
   * One ingest in flight per watch; it checks again when it finishes. A
   * quiet database (`idle`) flushes at a share of the limit, unless a
   * failed flush raised the trigger.
   */
  function maybeIngest(watch: IngestWatch, idle = false): void {
    const trigger =
      idle && watch.triggerAt === watch.maxWalBytes ? watch.maxWalBytes / IDLE_FLUSH_SHARE : watch.triggerAt;
    if (watch.state !== "idle" || watch.pendingBytes < trigger || watching !== watch) return;
    watch.state = "ingesting";
    clearTimeout(watch.due);
    watch.due = undefined;
    void (async () => {
      try {
        await fold();
        compact().catch(() => undefined);
      } catch (err) {
        // A database `destroyDb` removed is not a failure.
        if (!(err instanceof ClosedError)) failed("ingest", err);
        watch.triggerAt = watch.pendingBytes + watch.maxWalBytes;
      } finally {
        watch.state = "idle";
      }
      maybeIngest(watch);
      // What arrived during the ingest waits for the next quiet stretch.
      quiet(watch);
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
  async function destroy(): Promise<void> {
    destroying = true;
    try {
      await withLock(compactLock(name), () =>
        exclusive(() =>
          withStores(
            async ({ wal, fs }) => {
              await recordEmpty(wal, fs, undefined);
              trusted = GENERATION_NONE;
              if (watching) watching.pendingBytes = 0;
              await unlessHeld(name, () => reclaimManifests(fs, asGeneration(Number.POSITIVE_INFINITY)));
              await reclaim(fs, wal);
            },
          ),
        ),
      );
    } finally {
      destroying = false;
      announceGeneration(name);
    }
  }

  /**
   * `reconcile` for a tab, with no generation trusted: the tab asks because
   * the recorded one did not load, or because its open found a manifest to
   * adopt.
   */
  async function repair(): Promise<void> {
    await exclusive(() =>
      withStores(
        async ({ wal, fs }) => {
          trusted = (await reconcile(wal, fs, undefined)).generation;
        },
      ),
    );
  }

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return publishTurn(() => withLock(ingestLock(name), fn));
  }

  /** `fn` on the WAL database for one operation, or `gone()` when it does not exist. */
  async function withWal<T>(fn: (wal: IdBWal) => Promise<T>, gone: () => T | Promise<T>): Promise<T> {
    const wal = await openExistingWal(name);
    if (!wal) return gone();
    try {
      return await fn(wal);
    } finally {
      wal.close();
    }
  }

  /** The WAL database's meta, or undefined when it does not exist. */
  function walMeta(): Promise<WalMeta | undefined> {
    return withWal((wal) => wal.meta(), () => undefined);
  }

  /** The WAL database's meta. Rejects with `destroyed()` when it does not exist. */
  async function walMetaOrDestroyed(): Promise<WalMeta> {
    const meta = await walMeta();
    if (!meta) throw destroyed();
    return meta;
  }

  /**
   * Resolves the folder once: the pass holds the compaction lock throughout,
   * and `destroyDb` takes it before it removes the folder. Each step opens
   * the WAL database again, and the pass stops quietly once it is gone.
   */
  async function compactPass(): Promise<void> {
    const fs = await folder();
    if (!fs) return;
    let installed = false;
    let steps = 0;
    try {
      for (let i = 0; i < MAX_COMPACTION_STEPS && !destroying; i++) {
        const meta = await walMeta();
        if (!meta) return;
        const base = await loadGeneration(fs, meta.generation ?? GENERATION_NONE);
        // Gone when a flush installed a newer generation since: plan again.
        if (!base) continue;
        const budget = currentBudget();
        const merged = await withRoom(() => mergeNextStep(fs, budget, base, meta.top, () => stopped));
        recycleEngine(budget.wasmRecycleBytes);
        if (!merged) return await settle(meta);
        const landed = await withRoom(() =>
          exclusive(() =>
            withWal(
              async (wal) => {
                trusted = await installStep(fs, wal, merged, trusted);
                await reclaim(fs, wal);
                return true;
              },
              () => false,
            ),
          ),
        );
        if (!landed) return;
        installed = true;
        steps += 1;
        meter.compacted(name);
        installLanded();
        announceGeneration(name);
      }
    } finally {
      // A pass cut off at the step limit asks for another, which queues behind
      // the lock's waiters; a step that threw never reached the limit.
      if (steps === MAX_COMPACTION_STEPS && !destroying) compact().catch(() => undefined);
      // A pass that installed nothing sweeps once, for the files an earlier
      // pass had to leave. Last, so it never delays a merge that a full L0
      // waits for, and best-effort: the next pass sweeps again.
      if (!installed && !destroying) {
        await exclusive(() => withWal((wal) => sweepIdle(fs, wal), () => undefined)).catch(() => undefined);
      }
    }
  }

  /**
   * Run a write. When the browser refuses it and the reserve is released
   * for it, run it once more: a flush then resumes from `ingestedThrough`.
   */
  async function withRoom<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (!isQuota(err) || !(await refused())) throw err;
      return write();
    }
  }

  /**
   * The browser refused a write of this database, the host's or a tab's.
   * True when the reserve was released for it. Resolves once the file is
   * gone, whoever removed it.
   */
  async function refused(): Promise<boolean> {
    if (!watching?.reserveBytes) return false;
    const meta = await walMeta();
    return meta !== undefined && onReserve({ kind: "refused", head: meta.head });
  }

  /**
   * A pass found the recorded generation in shape. The reserve is written,
   * and the handlers asked again, only here: by then a flush holds what they
   * wrote and compaction has dropped what it could.
   */
  async function settle({ head, ingestedThrough }: WalMeta): Promise<void> {
    const watch = watching;
    if (!watch) return;
    try {
      await onReserve({ kind: "settle", ingestedThrough, head, target: watch.reserveBytes });
    } catch (err) {
      failed("writing the reserve", err);
    }
  }

  /** The handlers settled, so every write of theirs is at or below the head read now. */
  async function answered(): Promise<void> {
    const meta = await walMeta();
    if (meta) await onReserve({ kind: "done", head: meta.head, ingestedThrough: meta.ingestedThrough });
  }

  /**
   * Move the reserve by `event`, then by the outcome of each effect, in one
   * exclusive section: the file has one writer at a time, across hosts, and
   * a fill never overlaps a flush. True when it released the file. An event
   * that changes nothing takes no lock, unless it is a refused write: a
   * release in flight has the state ahead of the file.
   */
  function onReserve(event: ReserveEvent): Promise<boolean> {
    const first = step(reserve, event);
    if (event.kind !== "refused" && first.next === reserve && first.effect.kind === "none") return Promise.resolve(false);
    return exclusive(async () => {
      const fs = await folder();
      if (!fs) return false;
      let released = false;
      for (let next: ReserveEvent | undefined = event; next; ) {
        const moved = step(reserve, next);
        reserve = moved.next;
        released ||= moved.effect.kind === "release";
        next = await act(fs, moved.effect);
      }
      return released;
    });
  }

  /** Run `effect`, and return the event that says how it went. */
  async function act(fs: AsyncFs, effect: ReserveEffect): Promise<ReserveEvent | undefined> {
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
        await postOffer(fs);
        return undefined;
      case "offer":
        await postOffer(fs);
        return undefined;
      case "flush":
        ingest(false).catch((err: unknown) => {
          if (!(err instanceof ClosedError)) failed("ingest", err);
        });
        return undefined;
    }
  }

  /** Tell the tabs the browser refused a write. The handle that holds the full lock answers (`Db.onStorageFull`). */
  async function postOffer(fs: AsyncFs): Promise<void> {
    const watch = watching;
    if (!watch?.bus) return;
    const bytes = await withWal(
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
  async function reclaim(fs: AsyncFs, wal: IdBWal): Promise<void> {
    await unlessHeld(name, async () => {
      const { generation } = await reconcile(wal, fs, trusted);
      trusted = generation;
      await sweep(fs, generation, (await wal.meta()).destroyedTop);
    });
  }

  /**
   * The sweep of a pass that installed nothing. It repairs nothing: when
   * the recorded generation is not the one this host last checked, it
   * leaves the files, the next flush reconciles, and a later pass sweeps.
   * It needs no reconcile for the one it did check: `sweep` reads that
   * manifest before it removes anything, and stops if it is gone.
   */
  async function sweepIdle(fs: AsyncFs, wal: IdBWal): Promise<void> {
    await unlessHeld(name, async () => {
      const meta = await wal.meta();
      const generation = meta.generation ?? GENERATION_NONE;
      if (generation === trusted) await sweep(fs, generation, meta.destroyedTop);
    });
  }

  /**
   * Tests only (tests/compact-host.ts). Wait for a fold in flight, reconcile
   * and remove old manifests as a fold that found nothing to fold does, then
   * compact until the levels are in shape. Folds no WAL.
   */
  async function compactOnly(): Promise<void> {
    await foldTurn(() =>
      exclusive(() =>
        withStores(async ({ wal, fs }) => {
          const { generation } = await reconcile(wal, fs, trusted);
          trusted = generation;
          await unlessHeld(name, () => reclaimManifests(fs, generation));
        }),
      ),
    );
    await compact();
  }

  return {
    ingest,
    watch: addWatcher,
    unwatch: removeWatcher,
    refused,
    repair,
    destroy,
    // Reached by tests: compact-host.ts and the idle step of io-error-crash.test.ts.
    compactOnly,
    compact,
  };
}

type HostedDb = ReturnType<typeof hostedDb>;

/** Reads the manifest of `generation` first, so a missing one throws before any file goes. */
async function sweep(fs: AsyncFs, generation: Generation, destroyedTop: Generation): Promise<void> {
  const live = await liveRuns(fs, generation, destroyedTop);
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

/**
 * Serve the host `build` makes to every tab that connects to this
 * SharedWorker, or, in a dedicated Worker, to the page that started it. A
 * SharedWorker's host writes run files the way `fileWrites` finds. A
 * dedicated Worker's host writes none: each handle starts its own, and
 * several hosts do not share one reserve (docs/reserve.md, "Several
 * hosts"). The testing worker passes `everywhere` for the proofs that run
 * such hosts. Where `fileWrites` has to try, the ports are served at once
 * and each request waits for the host, so no connect event and no request
 * is lost.
 */
export function serveWorker(build: (writes: FileWrites) => EngineHost, everywhere = false): void {
  // Read off `globalThis`, so the main tsc build needs no webworker lib.
  const scope = globalThis as unknown as MessagePort & { onconnect?: ((ev: MessageEvent) => void) | null };
  const shared = "onconnect" in scope;
  const host = Promise.resolve(shared || everywhere ? fileWrites() : undefined).then(build);
  if (!shared) {
    attachEngineHostPort(scope, host);
    return;
  }
  scope.onconnect = (ev) => {
    const port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
    if (port) attachEngineHostPort(port, host);
  };
}

/** Serve EngineHost over a MessagePort (SharedWorker connection or test channel). A host still being built answers once it is. */
export function attachEngineHostPort(
  port: MessagePort,
  served: EngineHost | Promise<EngineHost>,
): () => void {
  const listener = (async (ev: MessageEvent<ClientToHost | null>) => {
    const id = ev.data?.id;
    try {
      // A message that is not a call throws here, and gets no answer.
      const { method, args } = ev.data!;
      const host = await served;
      // A tab of a newer build: answer, so its request does not wait forever.
      if (!Object.hasOwn(HOST_CALLS, method)) throw new StorageUnavailableError(`the SharedWorker does not serve "${method}"`);
      const value: unknown = await Reflect.apply(host[method], host, args);
      if (id !== undefined) port.postMessage({ id, value } satisfies HostToClient);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (id !== undefined) port.postMessage({ id, message, code: codeOfError(err) } satisfies HostToClient);
    }
  }) as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();
  return () => port.removeEventListener("message", listener);
}

/** An in-process client: each call of `HOST_CALLS` calls `host` directly. */
export function createLocalIngestClient(host: EngineHost): IngestClient {
  const client: Record<string, unknown> = { close: () => undefined };
  for (const method of Object.keys(HOST_CALLS) as HostCall[]) {
    client[method] = (...args: unknown[]) => Reflect.apply(host[method], host, args);
  }
  return client as IngestClient;
}
