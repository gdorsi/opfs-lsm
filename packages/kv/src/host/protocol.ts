import type { WriterId } from "../check.js";
import type { ErrorCode } from "../errors.js";
import { reclaimLock, webLocks } from "../locks.js";
import type { IoCounters } from "../opfs/counting-fs.js";

/** What the host counted for one database since it started. Test and bench only. */
export type HostStats = {
  /** Flush (l0), compaction outputs (lN), manifests (m), compaction input reads. */
  fs: IoCounters;
  /** L0 runs flushed from the WAL. An ingest of a large backlog publishes several. */
  flushes: number;
  /** Times a flush of this database found L0 full and waited for compaction before publishing another run. */
  l0Stops: number;
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
  };
};

/** What a tab tells the host when it opens a database. The host uses the smallest figure of each. */
export type WatchPolicy = {
  /** The tab's `maxWalBytes`. */
  readonly maxWalBytes: number;
  /** The tab's `compactionMemoryBytes`, which sets the host's `hostBudget`. */
  readonly compactionMemoryBytes: number;
  /** The tab's `maxBytes`. Absent: this tab asks for no cap. */
  readonly maxBytes?: number | undefined;
};

/** What the host measured over `maxBytes`. See `Db.onPressure`. */
export type Pressure = {
  /** Bytes of the run files the recorded manifest lists. */
  readonly bytes: number;
  /** The smallest `maxBytes` any tab passed since the database was last closed by all. */
  readonly maxBytes: number;
  /** Bytes to free to come back to 7/8 of `maxBytes`. */
  readonly need: number;
};

/**
 * What goes on `layersChannel`: a tab posts each record it appends, the host posts `ingest` for a new generation
 * and `pressure` for an offer over `maxBytes`. The tab holding `pressureLock` posts `pressure-pull` when it takes
 * the lock, for the open offer, and `pressure-done` when its handlers settle.
 * A build that does not know a kind catches up from the WAL, so a new shape takes a new kind.
 */
export type BusMessage =
  | {
      readonly kind: "row";
      readonly writerId: WriterId;
      readonly seq: number;
      /** The WAL row of `seq`. One buffer clones in one copy; the ops it holds would clone one by one. */
      readonly record: ArrayBuffer;
      /** The key and value bytes of its ops (`opsBytes`), for the host's ingest trigger. */
      readonly bytes: number;
    }
  | { readonly kind: "ingest" }
  | { readonly kind: "pressure"; readonly pressure: Pressure }
  | { readonly kind: "pressure-pull" | "pressure-done" };

/**
 * Run `fn` holding the reclaim lock shared. While any tab holds it, the
 * host removes no run file and no manifest, so a generation recorded
 * during `fn` keeps its files until `fn` returns. Waits only for a
 * reclaim already running. Without Web Locks it runs `fn` unprotected.
 */
export function holdingFiles<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const manager = webLocks();
  if (!manager) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return manager.request(reclaimLock(name), { mode: "shared" }, fn) as unknown as Promise<T>;
}

/**
 * Run `fn` holding the reclaim lock exclusively, or skip it and return
 * false when a tab holds it. Never waits, so no tab can stall the host.
 */
export async function unlessHeld(name: string, fn: () => Promise<void>): Promise<boolean> {
  const manager = webLocks();
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
      readonly waitForCompaction: boolean;
    }
  | {
      readonly type: "watch";
      readonly name: string;
      readonly maxWalBytes: number;
      /** Absent from a tab of a build before the option existed. */
      readonly compactionMemoryBytes?: number;
      readonly maxBytes?: number | undefined;
    }
  | { readonly type: "unwatch"; readonly name: string }
  | { readonly type: "destroy"; readonly id: number; readonly name: string }
  | { readonly type: "stats"; readonly id: number; readonly name: string };

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
  | { readonly type: "stats-ok"; readonly id: number; readonly stats: HostStats }
  | { readonly type: "destroy-ok"; readonly id: number };

export type IngestClient = {
  /**
   * Flush every WAL record acked before the call. A no-op when they are
   * already in OPFS. With `waitForCompaction`, resolve once compaction has finished too.
   */
  ingest(name: string, waitForCompaction?: boolean): Promise<{ generation: number }>;
  /**
   * Have the host ingest `name` on its own once the WAL waiting for ingest
   * passes `policy.maxWalBytes`, starting with what is already waiting,
   * hold its flushes and compactions to `policy.compactionMemoryBytes`, and
   * offer pressure over `policy.maxBytes`.
   */
  watch(name: string, policy: WatchPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  /** Delete every file and WAL record of `name`. See `Db.dangerousDestroy`. */
  destroy(name: string): Promise<void>;
  /** Host counters for `name`. Test and bench only. */
  stats(name: string): Promise<HostStats>;
  close(): void;
};
