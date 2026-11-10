import { checkDbName, opsBytes, type CheckedOp, type DbName } from "../check.js";
import { errorOfCode, OpfsLsmError } from "../errors.js";
import { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { reconcile } from "../recover.js";
import { CountingFs } from "../opfs/counting-fs.js";
import {
  listRuns,
  liveRuns,
  loadGeneration,
  reclaimManifests,
  reclaimRuns,
} from "../store/generation.js";
import { levelOf } from "../store/levels.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestChunk, type IngestResult } from "./ingest.js";
import {
  layersChannel,
  unlessHeld,
  type ClientToHost,
  type HostStats,
  type HostToClient,
  type IngestClient,
} from "./protocol.js";

export type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

/** What the host holds to keep its working set small. */
export type HostLimits = {
  /**
   * Op bytes of WAL records folded into one L0 run: a sixteenth of a 32 MiB
   * budget, within 1 to 4 MiB. A larger backlog becomes several runs.
   */
  readonly flushRunBytes: number;
  /**
   * L0 runs at which a flush waits for a compaction step to install before it
   * publishes another. One less than the sources a merge reads, so one step
   * can take all of L0.
   */
  readonly l0StopRuns: number;
};

const DEFAULT_HOST_LIMITS: HostLimits = {
  flushRunBytes: 2 * 1024 * 1024,
  l0StopRuns: 15,
};

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

/** The `append` messages tabs post on `layersChannel` (see `DbImpl.broadcast`). */
type AppendHint = { readonly kind: string; readonly ops?: readonly CheckedOp[] };

/** Background pending-byte read. `rows` stays 0: the host does not list the WAL. */
export type WatchScan = {
  ms: number;
  rows: number;
  bytes: number;
};

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort.
 *
 * Every manifest publish runs under one exclusive section per database: a
 * chain in this host plus a Web Lock across hosts. Two SharedWorkers can
 * serve one database, for example two builds whose script URLs differ.
 * A flush holds it for one L0 run at a time. Compaction merges without it and
 * holds it only to install the merged run.
 */
export class EngineHost {
  private readonly fsCache = new Map<string, CountingFs>();
  private readonly counts = new Map<DbName, HostCounts>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly folds = new Map<string, Promise<unknown>>();
  /** Per database, settles at the next compaction install, for a flush that waits on a full L0. */
  private readonly installs = new Map<
    DbName,
    { readonly settled: Promise<void>; readonly settle: () => void }
  >();
  private readonly compactions = new Map<string, Promise<void>>();
  private readonly compactAgain = new Set<string>();
  private readonly watches = new Map<DbName, IngestWatch>();
  /**
   * Run files out of every live generation that a tab still held at the
   * last try. A cache of what the manifests and directories say: a missing
   * entry means this host has not swept that database yet.
   */
  private readonly retired = new Map<DbName, Set<string>>();
  /**
   * Per database, the generation this host last published or found intact,
   * so `reconcile` checks a recorded manifest's runs once, not on every
   * flush. A tab that records another generation makes the host check again.
   */
  private readonly trusted = new Map<DbName, number>();
  private readonly limits: HostLimits;

  constructor(
    private readonly fsFactory: FsFactory,
    limits: Partial<HostLimits> = {},
  ) {
    this.limits = { ...DEFAULT_HOST_LIMITS, ...limits };
  }

  /** Every fs the host uses is counted, so stats need no hooks in ingest or compaction. */
  async fsFor(name: DbName): Promise<CountingFs> {
    let fs = this.fsCache.get(name);
    if (!fs) {
      const inner = await this.fsFactory(name);
      fs = this.fsCache.get(name) ?? new CountingFs(inner);
      this.fsCache.set(name, fs);
    }
    return fs;
  }

  private countsFor(dbName: DbName): HostCounts {
    let counts = this.counts.get(dbName);
    if (!counts) {
      counts = { flushes: 0, l0Stops: 0, compactionSteps: 0, foldedBytes: 0 };
      this.counts.set(dbName, counts);
    }
    return counts;
  }

  /**
   * What this host counted for `name` since it started. `generation` and
   * `layout` describe the recorded generation; their manifest read bypasses
   * the counters.
   */
  async stats(name: string): Promise<HostStats> {
    const dbName = checkDbName(name);
    const fs = await this.fsFor(dbName);
    const recorded = await this.withWal(dbName, async (wal) => (await wal.meta()).generation ?? 0);
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
      ...this.countsFor(dbName),
      generation: latest?.generation ?? 0,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
    });
  }

  /**
   * Flush every WAL record through `through` into an L0 run, then start
   * compaction in the background. With `settle`, also wait until the levels
   * are in shape.
   */
  async ingest(
    name: string,
    through: number,
    settle = false,
  ): Promise<{ generation: number }> {
    const dbName = checkDbName(name);
    const { generation } = await this.fold(dbName, through);
    const compaction = this.compact(dbName);
    if (!settle) {
      compaction.catch(() => undefined);
      return { generation };
    }
    await compaction;
    return {
      generation: await this.withWal(dbName, async (wal) => (await wal.meta()).generation ?? 0),
    };
  }

  private trust(dbName: DbName): (generation: number) => boolean {
    return (generation) => this.trusted.get(dbName) === generation;
  }

  /**
   * Fold the WAL as it stands now into L0 runs of `flushRunBytes`, oldest
   * first. One fold runs at a time per database, so a flush asked for during
   * another waits for it and finds its records ingested. Each run is its own
   * exclusive section, so a compaction install waits for one run, not for the
   * whole backlog. Records acked after the fold starts are left for the next
   * flush, so a steady writer cannot keep one fold going. While L0 holds
   * `l0StopRuns` runs it publishes none, and waits for compaction instead.
   */
  private fold(dbName: DbName, through: number): Promise<IngestResult> {
    return inTurn(this.folds, dbName, () => this.foldRuns(dbName, through));
  }

  private async foldRuns(dbName: DbName, through: number): Promise<IngestResult> {
    const fs = await this.fsFor(dbName);
    const head = await this.withWal(dbName, async (wal) => (await wal.meta()).head);
    const target = Math.min(through, head);
    const counts = this.countsFor(dbName);
    let foldedBytes = 0;
    let pastStop = false;
    for (;;) {
      // Taken before the attempt, so an install that lands during it is not missed.
      const installed = this.nextInstall(dbName);
      const chunk = await this.exclusive(dbName, () =>
        this.withWal(dbName, async (wal) => {
          const folded = await ingestChunk(wal, fs, target, this.trust(dbName), {
            maxBytes: this.limits.flushRunBytes,
            l0Stop: pastStop ? Number.POSITIVE_INFINITY : this.limits.l0StopRuns,
          });
          // Skipped while a tab loads a generation; the next flush or reclaim removes them.
          await unlessHeld(dbName, () => reclaimManifests(fs, folded.generation));
          return folded;
        }),
      );
      pastStop = false;
      this.trusted.set(dbName, chunk.generation);
      if (chunk.kind === "stopped") {
        counts.l0Stops += 1;
        pastStop = (await this.waitForInstall(dbName, installed)) === "idle";
        continue;
      }
      foldedBytes += chunk.foldedBytes;
      counts.foldedBytes += chunk.foldedBytes;
      if (chunk.kind === "folded") counts.flushes += 1;
      const watch = this.watches.get(dbName);
      if (watch) {
        watch.pendingBytes = Math.max(0, watch.pendingBytes - chunk.foldedBytes);
        watch.triggerAt = watch.maxWalBytes;
      }
      if (chunk.kind === "empty" || chunk.ingestedThrough >= target) {
        return { generation: chunk.generation, ingestedThrough: chunk.ingestedThrough, foldedBytes };
      }
    }
  }

  /** A promise for the next compaction install of `dbName`. */
  private nextInstall(dbName: DbName): Promise<void> {
    let next = this.installs.get(dbName);
    if (!next) {
      let settle!: () => void;
      next = { settled: new Promise<void>((resolve) => (settle = resolve)), settle };
      this.installs.set(dbName, next);
    }
    return next.settled;
  }

  private installLanded(dbName: DbName): void {
    const next = this.installs.get(dbName);
    this.installs.delete(dbName);
    next?.settle();
  }

  /**
   * Wait for the install a full L0 needs, starting a compaction pass if none
   * runs. "idle" when compaction ends without one (nothing to merge, or it
   * failed): the flush then goes on, since waiting longer would wait for
   * nothing.
   */
  private async waitForInstall(dbName: DbName, installed: Promise<void>): Promise<"installed" | "idle"> {
    const ended = this.compact(dbName).then(
      () => "idle" as const,
      () => "idle" as const,
    );
    return Promise.race([installed.then(() => "installed" as const), ended]);
  }

  /**
   * Ingest `name` on the host's own once its WAL passes `maxWalBytes`, with
   * no tab asking. Reads the byte counter in the background and ingests
   * when a reopened database is already over the limit.
   */
  watch(name: string, maxWalBytes: number, onScan?: (scan: WatchScan) => void): void {
    const dbName = checkDbName(name);
    const watch = this.watches.get(dbName) ?? this.startWatch(dbName, maxWalBytes);
    watch.watchers += 1;
    watch.maxWalBytes = Math.min(watch.maxWalBytes, maxWalBytes);
    watch.triggerAt = watch.maxWalBytes;
    const scanAt = onScan ? performance.now() : 0;
    void this.withWal(dbName, (wal) => wal.uningestedBytes()).then(
      (waiting) => {
        if (onScan) {
          onScan({
            ms: performance.now() - scanAt,
            rows: 0,
            bytes: waiting,
          });
        }
        watch.pendingBytes = Math.max(watch.pendingBytes, waiting);
        this.maybeIngest(dbName, watch);
      },
      (err: unknown) => {
        if (isClosedDatabase(err)) return;
        console.error(`opfs-lsm: reading the WAL of ${dbName} failed`, err);
      },
    );
  }

  unwatch(name: string): void {
    const dbName = checkDbName(name);
    const watch = this.watches.get(dbName);
    if (!watch || --watch.watchers > 0) return;
    watch.bus?.close();
    this.watches.delete(dbName);
  }

  private startWatch(dbName: DbName, maxWalBytes: number): IngestWatch {
    const watch: IngestWatch = {
      maxWalBytes,
      pendingBytes: 0,
      triggerAt: maxWalBytes,
      state: "idle",
      watchers: 0,
      bus: undefined,
    };
    if (typeof BroadcastChannel !== "undefined") {
      watch.bus = new BroadcastChannel(layersChannel(dbName));
      watch.bus.onmessage = (ev: MessageEvent<AppendHint | null>) => {
        if (ev.data?.kind !== "append" || !ev.data.ops) return;
        watch.pendingBytes += opsBytes(ev.data.ops);
        this.maybeIngest(dbName, watch);
      };
    }
    this.watches.set(dbName, watch);
    return watch;
  }

  /** One ingest in flight per watch; it checks again when it finishes. */
  private maybeIngest(dbName: DbName, watch: IngestWatch): void {
    if (
      watch.state !== "idle" ||
      watch.pendingBytes < watch.triggerAt ||
      this.watches.get(dbName) !== watch
    ) {
      return;
    }
    watch.state = "ingesting";
    void (async () => {
      try {
        const { foldedBytes } = await this.fold(dbName, Number.POSITIVE_INFINITY);
        if (foldedBytes > 0) announceGeneration(dbName);
        // Nothing was waiting, so the count was ahead of the WAL. Without
        // this, it would stay over the trigger and ingest in a loop.
        else watch.pendingBytes = 0;
        this.compact(dbName).catch(() => undefined);
      } catch (err) {
        console.error(`opfs-lsm: ingest of ${dbName} failed`, err);
        watch.triggerAt = watch.pendingBytes + watch.maxWalBytes;
      } finally {
        watch.state = "idle";
      }
      this.maybeIngest(dbName, watch);
    })();
  }

  private exclusive<T>(dbName: DbName, fn: () => Promise<T>): Promise<T> {
    return inTurn(this.chains, dbName, () => withLock(`opfs-lsm-ingest/${dbName}`, fn));
  }

  private async withWal<T>(
    dbName: DbName,
    fn: (wal: IdBWal) => Promise<T>,
  ): Promise<T> {
    const wal = await IdBWal.open(dbName);
    try {
      return await fn(wal);
    } finally {
      wal.close();
    }
  }

  /** Run compaction passes until no request arrives during one. */
  private compact(dbName: DbName): Promise<void> {
    const running = this.compactions.get(dbName);
    if (running) {
      this.compactAgain.add(dbName);
      return running;
    }
    const run = (async () => {
      try {
        do {
          this.compactAgain.delete(dbName);
          await withLock(`opfs-lsm-compact/${dbName}`, () =>
            this.compactPass(dbName),
          );
        } while (this.compactAgain.has(dbName));
      } finally {
        this.compactions.delete(dbName);
      }
    })();
    this.compactions.set(dbName, run);
    return run;
  }

  private async compactPass(dbName: DbName): Promise<void> {
    const fs = await this.fsFor(dbName);
    if (this.retired.get(dbName)?.size !== 0) {
      await this.exclusive(dbName, () =>
        this.withWal(dbName, (wal) => this.reclaim(dbName, fs, wal)),
      );
    }
    for (let i = 0; i < MAX_COMPACTION_STEPS; i++) {
      const meta = await this.withWal(dbName, (wal) => wal.meta());
      const base = await loadGeneration(fs, meta.generation ?? 0);
      // Gone when a flush installed a newer generation since: plan again.
      if (!base) continue;
      const step = await mergeNextStep(fs, base, meta.top);
      if (!step) return;
      await this.exclusive(dbName, () =>
        this.withWal(dbName, async (wal) => {
          this.trusted.set(dbName, await installStep(fs, wal, step, this.trust(dbName)));
          // No set yet: no reclaim has run, and the first one lists every run.
          for (const path of step.inputs) this.retired.get(dbName)?.add(path);
          await this.reclaim(dbName, fs, wal);
        }),
      );
      this.countsFor(dbName).compactionSteps += 1;
      this.installLanded(dbName);
      announceGeneration(dbName);
    }
  }

  /**
   * Remove the manifests older than the recorded one and the retired runs
   * no tab holds. The first call for a database retires every run file
   * outside the live generations, which also collects what a crash left
   * behind. Needs the ingest and compaction locks, so no run being written
   * is mistaken for an orphan. Reconciles first: after a power loss the
   * recorded manifest can be gone, and sweeping against it would remove
   * the runs recovery needs.
   *
   * Skipped, without waiting, while a tab holds the reclaim lock to load a
   * generation (`holdingFiles`): the retired runs stay retired and the next
   * pass tries again (design.md, "Loading a generation under churn").
   */
  private async reclaim(dbName: DbName, fs: AsyncFs, wal: IdBWal): Promise<void> {
    await unlessHeld(dbName, async () => {
      const { generation } = await reconcile(wal, fs, this.trust(dbName));
      this.trusted.set(dbName, generation);
      await reclaimManifests(fs, generation);
      const retired = this.retired.get(dbName) ?? new Set(await listRuns(fs));
      const keep = await liveRuns(fs, generation);
      this.retired.set(dbName, new Set(await reclaimRuns(fs, retired, keep)));
    });
  }
}

/** Tell the tabs to install the new generation and drop the merged runs. */
function announceGeneration(dbName: DbName): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bus = new BroadcastChannel(layersChannel(dbName));
  bus.postMessage({ kind: "ingest", writerId: "engine-host" });
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

/** Run `fn` once everything queued before it under `key` has settled. */
function inTurn<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } })
    .navigator?.locks;
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
        case "ping":
          reply({ type: "pong", id: msg.id });
          return;
        case "ingest": {
          const { generation } = await host.ingest(
            msg.name,
            msg.through,
            msg.settle,
          );
          reply({ type: "ingest-ok", id: msg.id, generation });
          return;
        }
        case "watch":
          host.watch(
            msg.name,
            msg.maxWalBytes,
            msg.trace
              ? (scan) =>
                  reply({
                    type: "watch-trace",
                    ms: scan.ms,
                    rows: scan.rows,
                    bytes: scan.bytes,
                  })
              : undefined,
          );
          return;
        case "unwatch":
          host.unwatch(msg.name);
          return;
        case "stats":
          reply({ type: "stats-ok", id: msg.id, stats: await host.stats(msg.name) });
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
        reply(err instanceof OpfsLsmError ? { type: "err", id, message, code: err.code } : { type: "err", id, message });
      }
    }
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();
  return () => port.removeEventListener("message", listener);
}

/** Tab-side client over a MessagePort. */
export function createPortIngestClient(
  port: MessagePort,
  onWatchScan?: (scan: WatchScan) => void,
): IngestClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: HostToClient) => void; reject: (e: Error) => void }
  >();

  const onMessage = (ev: MessageEvent<HostToClient>) => {
    const msg = ev.data;
    if (msg.type === "watch-trace") {
      onWatchScan?.(msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "err") p.reject(errorOfCode(msg.code, msg.message));
    else p.resolve(msg);
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();

  const request = (msg: ClientToHost & { id: number }) =>
    new Promise<HostToClient>((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      port.postMessage(msg);
    });

  return {
    async ingest(name: string, through: number, settle = false) {
      const res = await request({ type: "ingest", id: nextId++, name, through, settle });
      return { generation: (res as Extract<HostToClient, { type: "ingest-ok" }>).generation };
    },
    watch(name, policy) {
      const msg: ClientToHost = {
        type: "watch",
        name,
        maxWalBytes: policy.maxWalBytes,
        ...(onWatchScan ? { trace: true } : {}),
      };
      port.postMessage(msg);
    },
    unwatch(name) {
      const msg: ClientToHost = { type: "unwatch", name };
      port.postMessage(msg);
    },
    async stats(name) {
      const res = await request({ type: "stats", id: nextId++, name });
      return (res as Extract<HostToClient, { type: "stats-ok" }>).stats;
    },
    close() {
      port.removeEventListener("message", listener);
      for (const [, p] of pending) p.reject(new Error("ingest client closed"));
      pending.clear();
    },
  };
}

export function createLocalIngestClient(host: EngineHost): IngestClient {
  return {
    ingest: (name, through, settle) => host.ingest(name, through, settle),
    watch: (name, policy) => host.watch(name, policy.maxWalBytes),
    unwatch: (name) => host.unwatch(name),
    stats: (name) => host.stats(name),
    close: () => undefined,
  };
}
