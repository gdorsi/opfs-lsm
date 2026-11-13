import { checkDbName, type DbName } from "../check.js";
import { codeOfError } from "../errors.js";
import { IdBWal, uningestedBytes } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { reconcile, recordEmpty } from "../recover.js";
import { CountingFs } from "../opfs/counting-fs.js";
import {
  listRuns,
  liveRuns,
  loadGeneration,
  reclaimManifests,
  reclaimRuns,
} from "../store/generation.js";
import { engineMemory, recycleEngine } from "../store/engine.js";
import { levelOf } from "../store/levels.js";
import { compactionMemoryOf, DEFAULT_COMPACTION_MEMORY_BYTES, hostBudget, type HostBudget } from "./budget.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestChunk, type IngestResult } from "./ingest.js";
import {
  unlessHeld,
  type BusMessage,
  type ClientToHost,
  type HostStats,
  type HostToClient,
  type IngestClient,
  type WatchPolicy,
} from "./protocol.js";
import { compactLock, ingestLock, layersChannel, webLocks } from "../locks.js";
import { coalesced, serial } from "../turns.js";

type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

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
};

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort. It keeps one
 * `HostedDb` per database name, for as long as the host lives.
 */
export class EngineHost {
  private readonly dbs = new Map<DbName, HostedDb>();

  /** `overrides` replace figures of the budget, for tests that need a small flush run or no L0 stop. */
  constructor(
    private readonly fsFactory: FsFactory,
    private readonly overrides: Partial<HostBudget> = {},
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
  async ingest(name: string, waitForCompaction = false): Promise<{ generation: number }> {
    return this.db(name).ingest(waitForCompaction);
  }

  /** Wait for a flush in flight, then compact until the levels are in shape. Folds no WAL. */
  async compact(name: string): Promise<void> {
    return this.db(name).compactNow();
  }

  /**
   * Ingest `name` on the host's own once its WAL passes `policy.maxWalBytes`,
   * with no tab asking. Reads up to `maxWalBytes` of the waiting records in the
   * background and ingests when a reopened database is already over the limit.
   * The host holds `name` to the smallest `compactionMemoryBytes` any tab passed.
   */
  watch(name: string, policy: WatchPolicy): void {
    this.db(name).watch(policy);
  }

  unwatch(name: string): void {
    this.db(name).unwatch();
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
 */
class HostedDb {
  private fsReady: Promise<CountingFs> | undefined;
  private readonly counts: HostCounts = { flushes: 0, l0Stops: 0, compactionSteps: 0, foldedBytes: 0 };
  private readonly publishTurn = serial();
  private readonly foldTurn = serial();
  /** Settles at the next compaction install, for a flush that waits on a full L0. */
  private nextInstall: { readonly settled: Promise<void>; readonly resolve: () => void } | undefined;
  private watching: IngestWatch | undefined;
  /**
   * The generation this host last published or found intact, so `reconcile`
   * checks a recorded manifest's runs once, not on every flush. A tab that
   * records another generation makes the host check again.
   */
  private trusted: number | undefined;
  /** Set while `destroy` waits for the locks, so a compaction pass stops at its next step. */
  private destroying = false;
  /** Run compaction passes until no request arrives during one. */
  private readonly compact = coalesced(() =>
    withLock(compactLock(this.name), () => this.compactPass()),
  );

  constructor(
    private readonly name: DbName,
    private readonly fsFactory: FsFactory,
    private readonly overrides: Partial<HostBudget>,
  ) {}

  private budget(): HostBudget {
    const asked = this.watching?.compactionMemoryBytes ?? DEFAULT_COMPACTION_MEMORY_BYTES;
    return { ...hostBudget(asked), ...this.overrides };
  }

  /** Every fs the host uses is counted, so stats need no hooks in ingest or compaction. */
  private fs(): Promise<CountingFs> {
    this.fsReady ??= Promise.resolve(this.fsFactory(this.name)).then(
      (inner) => new CountingFs(inner),
      (err: unknown) => {
        this.fsReady = undefined;
        throw err;
      },
    );
    return this.fsReady;
  }

  async stats(): Promise<HostStats> {
    const fs = await this.fs();
    const recorded = await this.withWal(async (wal) => (await wal.meta()).generation ?? 0);
    const latest = await loadGeneration(fs.inner, recorded);
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of latest?.runs ?? []) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += run.bytes;
      byLevel.set(level, entry);
    }
    return structuredClone({
      fs: fs.counters,
      ...this.counts,
      generation: latest?.generation ?? 0,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
      memory: engineMemory(),
    });
  }

  async ingest(waitForCompaction: boolean): Promise<{ generation: number }> {
    const { generation } = await this.fold();
    const compaction = this.compact();
    if (!waitForCompaction) {
      compaction.catch(() => undefined);
      return { generation };
    }
    await compaction;
    return {
      generation: await this.withWal(async (wal) => (await wal.meta()).generation ?? 0),
    };
  }

  /**
   * Wait for a fold in flight, reconcile and remove old manifests as a fold
   * that found nothing to fold does, then compact. Removes no run file here:
   * that needs the compaction lock, and `compactPass` does it under it.
   */
  async compactNow(): Promise<void> {
    const fs = await this.fs();
    await this.foldTurn(() =>
      this.exclusive(() =>
        this.withWal(async (wal) => {
          const { generation } = await reconcile(wal, fs, this.trusted);
          this.trusted = generation;
          await unlessHeld(this.name, () => reclaimManifests(fs, generation));
        }),
      ),
    );
    await this.compact();
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
    const fs = await this.fs();
    const target = await this.withWal(async (wal) => (await wal.meta()).head);
    let foldedBytes = 0;
    let pastStop = false;
    try {
      for (;;) {
        const budget = this.budget();
        // Taken before the attempt, so an install that lands during it is not missed.
        const installed = this.installSignal();
        const chunk = await this.exclusive(() =>
          this.withWal(async (wal) => {
            const folded = await ingestChunk(wal, fs, target, this.trusted, {
              maxBytes: budget.flushRunBytes,
              l0Stop: pastStop ? Number.POSITIVE_INFINITY : budget.l0StopRuns,
            });
            // Skipped while a tab loads a generation; the next flush or reclaim removes them.
            await unlessHeld(this.name, () => reclaimManifests(fs, folded.generation));
            return folded;
          }),
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
        if (chunk.kind === "empty" || chunk.ingestedThrough >= target) {
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
    watch.triggerAt = watch.maxWalBytes;
    void this.withWal((wal) => uningestedBytes(wal, watch.maxWalBytes)).then(
      (waiting) => {
        watch.pendingBytes = Math.max(watch.pendingBytes, waiting);
        this.maybeIngest(watch);
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
    this.watching = undefined;
  }

  private startWatch(policy: WatchPolicy): IngestWatch {
    const watch: IngestWatch = {
      maxWalBytes: policy.maxWalBytes,
      compactionMemoryBytes: policy.compactionMemoryBytes,
      pendingBytes: 0,
      triggerAt: policy.maxWalBytes,
      state: "idle",
      watchers: 0,
      bus: undefined,
    };
    if (typeof BroadcastChannel !== "undefined") {
      watch.bus = new BroadcastChannel(layersChannel(this.name));
      watch.bus.onmessage = (ev: MessageEvent<BusMessage>) => {
        if (ev.data.kind !== "rows") return;
        watch.pendingBytes += ev.data.bytes;
        this.maybeIngest(watch);
      };
    }
    this.watching = watch;
    return watch;
  }

  /** One ingest in flight per watch; it checks again when it finishes. */
  private maybeIngest(watch: IngestWatch): void {
    if (
      watch.state !== "idle" ||
      watch.pendingBytes < watch.triggerAt ||
      this.watching !== watch
    ) {
      return;
    }
    watch.state = "ingesting";
    void (async () => {
      try {
        const { foldedBytes } = await this.fold();
        // Nothing was waiting, so the count was ahead of the WAL. Without
        // this, it would stay over the trigger and ingest in a loop.
        if (foldedBytes === 0) watch.pendingBytes = 0;
        this.compact().catch(() => undefined);
      } catch (err) {
        console.error(`opfs-lsm: ingest of ${this.name} failed`, err);
        watch.triggerAt = watch.pendingBytes + watch.maxWalBytes;
      } finally {
        watch.state = "idle";
      }
      this.maybeIngest(watch);
    })();
  }

  /**
   * Empty the database, then remove the files no tab holds (design.md,
   * "Destroy"). Holds the compaction and ingest locks, so no flush or merge
   * publishes meanwhile, and a merge running when it is called stops after
   * its current step. `recordEmpty` is the commit point. Tabs follow it like
   * any new generation, and the runs a tab still holds go once it lets go,
   * at a later reclaim.
   */
  async destroy(): Promise<void> {
    this.destroying = true;
    try {
      await withLock(compactLock(this.name), () =>
        this.exclusive(() =>
          this.withWal(async (wal) => {
            const fs = await this.fs();
            await recordEmpty(wal, fs);
            this.trusted = 0;
            if (this.watching) this.watching.pendingBytes = 0;
            await unlessHeld(this.name, () => reclaimManifests(fs, Number.POSITIVE_INFINITY));
            await this.reclaim(fs, wal);
          }),
        ),
      );
    } finally {
      this.destroying = false;
      announceGeneration(this.name);
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.publishTurn(() => withLock(ingestLock(this.name), fn));
  }

  private async withWal<T>(fn: (wal: IdBWal) => Promise<T>): Promise<T> {
    const wal = await IdBWal.open(this.name);
    try {
      return await fn(wal);
    } finally {
      wal.close();
    }
  }

  private async compactPass(): Promise<void> {
    const fs = await this.fs();
    let installed = false;
    let steps = 0;
    try {
      for (let i = 0; i < MAX_COMPACTION_STEPS && !this.destroying; i++) {
        const meta = await this.withWal((wal) => wal.meta());
        const base = await loadGeneration(fs, meta.generation ?? 0);
        // Gone when a flush installed a newer generation since: plan again.
        if (!base) continue;
        const budget = this.budget();
        const step = await mergeNextStep(fs, budget, base, meta.top);
        recycleEngine(budget.wasmRecycleBytes);
        if (!step) return;
        await this.exclusive(() =>
          this.withWal(async (wal) => {
            this.trusted = await installStep(fs, wal, step, this.trusted);
            await this.reclaim(fs, wal);
          }),
        );
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
        await this.exclusive(() => this.withWal((wal) => this.sweepIdle(fs, wal))).catch(() => undefined);
      }
    }
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
      const generation = (await wal.meta()).generation ?? 0;
      if (generation === this.trusted) await sweep(fs, generation);
    });
  }
}

/** Reads the manifest of `generation` first, so a missing one throws before any file goes. */
async function sweep(fs: AsyncFs, generation: number): Promise<void> {
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

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (!locks) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return locks.request(name, fn) as unknown as Promise<T>;
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
          host.watch(msg.name, {
            maxWalBytes: msg.maxWalBytes,
            compactionMemoryBytes: compactionMemoryOf(msg.compactionMemoryBytes),
          });
          return;
        case "unwatch":
          host.unwatch(msg.name);
          return;
        case "stats":
          reply({ type: "stats-ok", id: msg.id, stats: await host.stats(msg.name) });
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
    destroy: (name) => host.destroy(name),
    stats: (name) => host.stats(name),
    close: () => undefined,
  };
}
