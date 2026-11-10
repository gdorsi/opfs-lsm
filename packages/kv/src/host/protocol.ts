import type { ErrorCode } from "../errors.js";
import type { IngestPolicy } from "../ingest-policy.js";
import type { IoCounters } from "../opfs/counting-fs.js";

/** What the host counted for one database since it started. Test and bench only. */
export type HostStats = {
  /** Flush (l0), compaction outputs (lN), manifests (m), compaction input reads. */
  fs: IoCounters;
  /** L0 runs flushed from the WAL. An ingest of a large backlog publishes several. */
  flushes: number;
  /** Compaction steps installed. */
  compactionSteps: number;
  /** Σ IngestResult.foldedBytes. */
  foldedBytes: number;
  generation: number;
  /** From the latest manifest, levels with at least one run. */
  layout: { level: number; runs: number; bytes: number }[];
  /**
   * The wasm figures are the SharedWorker's, shared by every database it
   * serves. None needs DevTools, so any browser reports them.
   */
  memory: {
    /** The wasm instance's memory now. It only grows, until a recycle replaces the instance. */
    wasmBytes: number;
    /** The most memory any wasm instance reached. */
    wasmPeakBytes: number;
    /** The most a merge session was asked to reserve. */
    mergeReservedBytes: number;
    /** Times the host replaced the wasm instance to give its memory back. */
    recycles: number;
    /** Times a flush of this database found L0 full and waited for compaction before publishing another run. */
    l0Stops: number;
  };
};

/** What a tab tells the host when it opens a database. The host uses the smallest figure of each. */
export type WatchPolicy = IngestPolicy & {
  /** The tab's `compactionMemoryBytes`, which sets the host's `hostBudget`. */
  readonly compactionMemoryBytes: number;
};

/** The BroadcastChannel where tabs share appends and new generations. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

function locks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

function reclaimLock(name: string): string {
  return `opfs-lsm-reclaim/${name}`;
}

/**
 * Run `fn` holding the reclaim lock shared. While any tab holds it, the
 * host removes no run file and no manifest, so a generation recorded
 * during `fn` keeps its files until `fn` returns. Waits only for a
 * reclaim already running. Without Web Locks it runs `fn` unprotected.
 */
export function holdingFiles<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (!manager) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return manager.request(reclaimLock(name), { mode: "shared" }, fn) as unknown as Promise<T>;
}

/**
 * Run `fn` holding the reclaim lock exclusively, or skip it and return
 * false when a tab holds it. Never waits, so no tab can stall the host.
 */
export async function unlessHeld(name: string, fn: () => Promise<void>): Promise<boolean> {
  const manager = locks();
  if (!manager) {
    await fn();
    return true;
  }
  return manager.request(reclaimLock(name), { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

export type ClientToHost =
  | {
      readonly type: "ingest";
      readonly id: number;
      readonly name: string;
      readonly through: number;
      readonly settle: boolean;
    }
  | {
      readonly type: "watch";
      readonly name: string;
      readonly maxWalBytes: number;
      /** Absent from a tab of a build before the option existed. The host then assumes the default. */
      readonly compactionMemoryBytes?: number;
      /** Ask the host to report the background WAL scan. Open does not wait for it. */
      readonly trace?: boolean;
    }
  | { readonly type: "unwatch"; readonly name: string }
  | { readonly type: "stats"; readonly id: number; readonly name: string }
  | { readonly type: "ping"; readonly id: number };

export type HostToClient =
  | {
      readonly type: "ingest-ok";
      readonly id: number;
      readonly generation: number;
    }
  | {
      readonly type: "err";
      readonly id: number;
      readonly message: string;
      /** The `OpfsLsmError` code, so the tab rethrows the same class. */
      readonly code?: ErrorCode;
    }
  | {
      readonly type: "watch-trace";
      readonly ms: number;
      readonly rows: number;
      readonly bytes: number;
    }
  | { readonly type: "stats-ok"; readonly id: number; readonly stats: HostStats }
  | { readonly type: "pong"; readonly id: number };

export type IngestClient = {
  /**
   * Flush every WAL record through `through`. A no-op when they are already
   * in OPFS. With `settle`, resolve once compaction has finished too.
   */
  ingest(
    name: string,
    through: number,
    settle?: boolean,
  ): Promise<{ generation: number }>;
  /**
   * Have the host ingest `name` on its own once the WAL waiting for ingest
   * passes `policy.maxWalBytes`, starting with what is already waiting, and
   * hold its flushes and compactions to `policy.compactionMemoryBytes`.
   */
  watch(name: string, policy: WatchPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  /** Host counters for `name`. Test and bench only. */
  stats(name: string): Promise<HostStats>;
  close(): void;
};
