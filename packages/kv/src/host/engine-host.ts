import { checkDbName, opsBytes, type CheckedOp, type DbName } from "../check.js";
import { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { CountingFs } from "../opfs/counting-fs.js";
import { loadLatestGeneration } from "../store/generation.js";
import { levelOf } from "../store/levels.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestAll, type IngestResult } from "./ingest.js";
import {
  layersChannel,
  type ClientToHost,
  type HostStats,
  type HostToClient,
  type IngestClient,
} from "./protocol.js";

export type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

/** Host counters for one database, besides the fs IO its CountingFs keeps. */
type HostCounts = {
  flushes: number;
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
 * A flush holds it for the whole flush. Compaction merges without it and
 * holds it only to install the merged run.
 */
export class EngineHost {
  private readonly fsCache = new Map<string, CountingFs>();
  private readonly counts = new Map<DbName, HostCounts>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly compactions = new Map<string, Promise<void>>();
  private readonly compactAgain = new Set<string>();
  private readonly watches = new Map<DbName, IngestWatch>();

  constructor(private readonly fsFactory: FsFactory) {}

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
      counts = { flushes: 0, compactionSteps: 0, foldedBytes: 0 };
      this.counts.set(dbName, counts);
    }
    return counts;
  }

  /**
   * What this host counted for `name` since it started. The manifest read
   * for `generation` and `layout` bypasses the counters.
   */
  async stats(name: string): Promise<HostStats> {
    const dbName = checkDbName(name);
    const fs = await this.fsFor(dbName);
    const latest = await loadLatestGeneration(fs.inner);
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of latest?.runs ?? []) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += fs.sizeOf(run.path) ?? 0;
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
    const fs = await this.fsFor(dbName);
    return { generation: (await loadLatestGeneration(fs))?.generation ?? 0 };
  }

  private async fold(dbName: DbName, through: number): Promise<IngestResult> {
    const fs = await this.fsFor(dbName);
    const result = await this.exclusive(dbName, () =>
      this.withWal(dbName, (wal) => ingestAll(wal, fs, through)),
    );
    const counts = this.countsFor(dbName);
    counts.foldedBytes += result.foldedBytes;
    if (result.foldedBytes > 0) counts.flushes += 1;
    const watch = this.watches.get(dbName);
    if (watch) {
      watch.pendingBytes = Math.max(0, watch.pendingBytes - result.foldedBytes);
      watch.triggerAt = watch.maxWalBytes;
    }
    return result;
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
    const prev = this.chains.get(dbName) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => withLock(`opfs-lsm-ingest/${dbName}`, fn));
    this.chains.set(
      dbName,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
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
    for (let i = 0; i < MAX_COMPACTION_STEPS; i++) {
      const step = await mergeNextStep(fs);
      if (!step) return;
      await this.exclusive(dbName, () =>
        this.withWal(dbName, (wal) => installStep(fs, wal, step)),
      );
      this.countsFor(dbName).compactionSteps += 1;
      announceGeneration(dbName);
    }
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
        reply({ type: "err", id: (msg as { id: number }).id, message });
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
    if (msg.type === "err") p.reject(new Error(msg.message));
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
