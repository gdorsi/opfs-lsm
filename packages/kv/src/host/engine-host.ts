import { checkDbName, type DbName } from "../check.js";
import { errorOfCode, OpfsLsmError } from "../errors.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { recoverGeneration } from "../recover.js";
import { CountingFs } from "../opfs/counting-fs.js";
import {
  listRuns,
  liveRuns,
  reclaimManifests,
  reclaimRuns,
} from "../store/generation.js";
import { levelOf } from "../store/levels.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestThrough, reclaimLogs, type IngestResult } from "./ingest.js";
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

/** Host counters for one database, besides the fs IO its CountingFs keeps. */
type HostCounts = {
  flushes: number;
  compactionSteps: number;
  foldedBytes: number;
};

/**
 * Ingest on the host's own for one database. Tabs count the log bytes
 * that became stable and ask for an ingest at a cut their watermark passed
 * (`ingest-request`); every tab sees the same stable order, so several may
 * ask for the same cut, and the fold of an older cut is a no-op.
 */
type IngestWatch = {
  /** The highest cut asked for. */
  wanted: number;
  state: "idle" | "ingesting";
  /** Open tabs that asked for this watch. The bus closes at zero. */
  watchers: number;
  bus: BroadcastChannel | undefined;
};

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort.
 *
 * Every manifest publish runs under one exclusive section per database: a
 * chain in this host plus a Web Lock across hosts. Two SharedWorkers can
 * serve one database, for example two builds whose script URLs differ.
 * A flush holds it for the whole flush. Compaction merges without it and
 * holds it only to install the merged run. Publishing a manifest commits:
 * the newest intact manifest is the committed generation (`recoverGeneration`).
 */
export class EngineHost {
  private readonly fsCache = new Map<string, CountingFs>();
  private readonly counts = new Map<DbName, HostCounts>();
  private readonly chains = new Map<string, Promise<unknown>>();
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
   * so recovery checks a manifest's runs once, not on every flush.
   */
  private readonly trusted = new Map<DbName, number>();

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
   * What this host counted for `name` since it started. `generation` and
   * `layout` describe the committed generation; their reads bypass the
   * counters.
   */
  async stats(name: string): Promise<HostStats> {
    const dbName = checkDbName(name);
    const fs = await this.fsFor(dbName);
    const { meta } = await recoverGeneration(fs.inner, this.trust(dbName));
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of meta.runs) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += fs.sizeOf(run.path) ?? 0;
      byLevel.set(level, entry);
    }
    return structuredClone({
      fs: fs.counters,
      ...this.countsFor(dbName),
      generation: meta.generation,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
    });
  }

  /**
   * Fold every log record at or below `cut` into an L0 run, then start
   * compaction in the background. With `settle`, also wait until the levels
   * are in shape. The caller's watermark passed `cut`, and every record at
   * or below it is durable in some tab's log.
   */
  async ingest(
    name: string,
    cut: number,
    settle = false,
  ): Promise<{ generation: number }> {
    const dbName = checkDbName(name);
    const { generation } = await this.fold(dbName, cut);
    const compaction = this.compact(dbName);
    if (!settle) {
      compaction.catch(() => undefined);
      return { generation };
    }
    await compaction;
    const fs = await this.fsFor(dbName);
    return { generation: (await recoverGeneration(fs, this.trust(dbName))).meta.generation };
  }

  private trust(dbName: DbName): (generation: number) => boolean {
    return (generation) => this.trusted.get(dbName) === generation;
  }

  private async fold(dbName: DbName, cut: number): Promise<IngestResult> {
    const fs = await this.fsFor(dbName);
    const result = await this.exclusive(dbName, async () => {
      const folded = await ingestThrough(fs, dbName, cut, this.trust(dbName));
      this.trusted.set(dbName, folded.generation);
      await reclaimLogs(fs, dbName, folded.cut);
      // Skipped while a tab loads a generation; the next flush or reclaim removes them.
      await unlessHeld(dbName, () => reclaimManifests(fs, folded.generation));
      return folded;
    });
    const counts = this.countsFor(dbName);
    counts.foldedBytes += result.foldedBytes;
    if (result.foldedBytes > 0) counts.flushes += 1;
    return result;
  }

  /** Ingest `name` on the host's own whenever a tab asks for a cut (`ingest-request`). */
  watch(name: string, _maxWalBytes?: number): void {
    const dbName = checkDbName(name);
    const watch = this.watches.get(dbName) ?? this.startWatch(dbName);
    watch.watchers += 1;
  }

  unwatch(name: string): void {
    const dbName = checkDbName(name);
    const watch = this.watches.get(dbName);
    if (!watch || --watch.watchers > 0) return;
    watch.bus?.close();
    this.watches.delete(dbName);
  }

  private startWatch(dbName: DbName): IngestWatch {
    const watch: IngestWatch = { wanted: 0, state: "idle", watchers: 0, bus: undefined };
    if (typeof BroadcastChannel !== "undefined") {
      watch.bus = new BroadcastChannel(layersChannel(dbName));
      watch.bus.onmessage = (ev: MessageEvent<{ kind?: string; cut?: number } | null>) => {
        if (ev.data?.kind !== "ingest-request" || typeof ev.data.cut !== "number") return;
        if (ev.data.cut > watch.wanted) watch.wanted = ev.data.cut;
        this.maybeIngest(dbName, watch);
      };
    }
    this.watches.set(dbName, watch);
    return watch;
  }

  /** One ingest in flight per watch; it checks again when it finishes. */
  private maybeIngest(dbName: DbName, watch: IngestWatch): void {
    if (watch.state !== "idle" || this.watches.get(dbName) !== watch) return;
    const cut = watch.wanted;
    watch.state = "ingesting";
    void (async () => {
      try {
        const { foldedBytes, generation } = await this.fold(dbName, cut);
        if (foldedBytes > 0) announceGeneration(dbName, generation);
        this.compact(dbName).catch(() => undefined);
      } catch (err) {
        console.error(`opfs-lsm: ingest of ${dbName} failed`, err);
      } finally {
        watch.state = "idle";
      }
      if (watch.wanted > cut) this.maybeIngest(dbName, watch);
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
      await this.exclusive(dbName, () => this.reclaim(dbName, fs));
    }
    for (let i = 0; i < MAX_COMPACTION_STEPS; i++) {
      const { meta: base, top } = await recoverGeneration(fs, this.trust(dbName));
      const step = await mergeNextStep(fs, base, top);
      if (!step) return;
      const installed = await this.exclusive(dbName, async () => {
        let generation: number;
        try {
          generation = await installStep(fs, step, this.trust(dbName));
        } catch (err) {
          // A flush replaced the base meanwhile; its inputs are still there, plan again.
          if (err instanceof Error && /left the committed generation/.test(err.message)) return undefined;
          throw err;
        }
        this.trusted.set(dbName, generation);
        // No set yet: no reclaim has run, and the first one lists every run.
        for (const path of step.inputs) this.retired.get(dbName)?.add(path);
        await this.reclaim(dbName, fs);
        return generation;
      });
      if (installed === undefined) continue;
      this.countsFor(dbName).compactionSteps += 1;
      announceGeneration(dbName, installed);
    }
  }

  /**
   * Remove the manifests older than the committed one and the retired runs
   * no tab holds. The first call for a database retires every run file
   * outside the live generations, which also collects what a crash left
   * behind. Needs the ingest and compaction locks, so no run being written
   * is mistaken for an orphan.
   *
   * Skipped, without waiting, while a tab holds the reclaim lock to load a
   * generation (`holdingFiles`): the retired runs stay retired and the next
   * pass tries again (design.md, "Loading a generation under churn").
   */
  private async reclaim(dbName: DbName, fs: AsyncFs): Promise<void> {
    await unlessHeld(dbName, async () => {
      const { meta } = await recoverGeneration(fs, this.trust(dbName), { underIngestLock: true });
      this.trusted.set(dbName, meta.generation);
      await reclaimManifests(fs, meta.generation);
      const retired = this.retired.get(dbName) ?? new Set(await listRuns(fs));
      const keep = await liveRuns(fs, meta.generation);
      this.retired.set(dbName, new Set(await reclaimRuns(fs, retired, keep)));
    });
  }
}

/** Tell the tabs to install the new generation and drop the merged runs. */
function announceGeneration(dbName: DbName, generation: number): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bus = new BroadcastChannel(layersChannel(dbName));
  bus.postMessage({ kind: "ingest", writerId: "engine-host", generation });
  bus.close();
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
          const { generation } = await host.ingest(msg.name, msg.cut, msg.settle);
          reply({ type: "ingest-ok", id: msg.id, generation });
          return;
        }
        case "watch":
          host.watch(msg.name, msg.maxWalBytes);
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
export function createPortIngestClient(port: MessagePort): IngestClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: HostToClient) => void; reject: (e: Error) => void }
  >();

  const onMessage = (ev: MessageEvent<HostToClient>) => {
    const msg = ev.data;
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
    async ingest(name: string, cut: number, settle = false) {
      const res = await request({ type: "ingest", id: nextId++, name, cut, settle });
      return { generation: (res as Extract<HostToClient, { type: "ingest-ok" }>).generation };
    },
    watch(name, policy) {
      const msg: ClientToHost = { type: "watch", name, maxWalBytes: policy.maxWalBytes };
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
    ingest: (name, cut, settle) => host.ingest(name, cut, settle),
    watch: (name, policy) => host.watch(name, policy.maxWalBytes),
    unwatch: (name) => host.unwatch(name),
    stats: (name) => host.stats(name),
    close: () => undefined,
  };
}
