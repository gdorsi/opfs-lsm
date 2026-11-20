import type { WriterId } from "../check.js";
import type { ErrorCode } from "../errors.js";
import { reclaimLock, webLocks, withLock } from "../locks.js";
import type { IoCounters } from "../opfs/counting-fs.js";
import type { Generation, Seq } from "../seq.js";

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
  generation: Generation;
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

/** What a tab tells the host when it opens a database, until the last tab closes it. */
export type WatchPolicy = {
  /** The tab's `maxWalBytes`. The host uses the smallest. */
  readonly maxWalBytes: number;
  /** The tab's `compactionMemoryBytes`, which sets the host's `hostBudget`. The host uses the smallest. */
  readonly compactionMemoryBytes: number;
  /** The tab's `reserveBytes`. The host keeps the largest. */
  readonly reserveBytes: number;
};

/** What `Db.onStorageFull` is told. */
export type StorageFull = {
  /** Bytes of the run files the recorded manifest lists: what this database holds on disk. */
  readonly bytes: number;
  /** The reserve's size: the bytes to free across the origin before the reserve fits again. */
  readonly need: number;
};

/**
 * What goes on `layersChannel`: a tab posts the records it appends, the host posts `ingest` for a new generation
 * and `full` for an offer, after the browser refused a write. The tab holding `fullLock` posts `full-pull` when it
 * takes the lock, for the open offer. `full-done` answers an offer: the holder posts it when its handlers settle,
 * and a handle with no handler when no handle holds the lock.
 * A build that does not know a kind catches up from the WAL, so a new shape takes a new kind.
 */
export type BusMessage =
  | {
      readonly kind: "rows";
      readonly writerId: WriterId;
      /** WAL rows this tab appended, in the order their acks resolved. One buffer clones in one copy; the ops it holds would clone one by one. */
      readonly rows: readonly BusRow[];
      /** The key and value bytes of their ops (`opsBytes`), for the host's ingest trigger. */
      readonly bytes: number;
    }
  | { readonly kind: "ingest" }
  | { readonly kind: "full"; readonly full: StorageFull }
  | { readonly kind: "full-pull" | "full-done" };

export type BusRow = { readonly seq: Seq; readonly record: ArrayBuffer };

/**
 * Run `fn` holding the reclaim lock shared. While any tab holds it, the
 * host removes no run file and no manifest, so a generation recorded
 * during `fn` keeps its files until `fn` returns. Waits only for a
 * reclaim already running. Without Web Locks it runs `fn` unprotected.
 */
export function holdingFiles<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withLock(reclaimLock(name), fn, "shared");
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
      readonly compactionMemoryBytes: number;
      readonly reserveBytes: number;
    }
  | { readonly type: "unwatch"; readonly name: string }
  | { readonly type: "make-room"; readonly id: number; readonly name: string }
  | { readonly type: "destroy"; readonly id: number; readonly name: string }
  | { readonly type: "repair"; readonly id: number; readonly name: string }
  | { readonly type: "stats"; readonly id: number; readonly name: string };

export type HostToClient =
  | {
      readonly type: "ingest-ok";
      readonly id: number;
      readonly generation: Generation;
    }
  | {
      readonly type: "err";
      readonly id: number;
      readonly message: string;
      /** The `OpfsLsmError` code, so the tab rethrows the same class. */
      readonly code?: ErrorCode;
    }
  | { readonly type: "stats-ok"; readonly id: number; readonly stats: HostStats }
  | { readonly type: "make-room-ok"; readonly id: number }
  | { readonly type: "destroy-ok"; readonly id: number }
  | { readonly type: "repair-ok"; readonly id: number };

export type IngestClient = {
  /**
   * Flush every WAL record acked before the call. A no-op when they are
   * already in OPFS. With `waitForCompaction`, resolve once compaction has finished too.
   */
  ingest(name: string, waitForCompaction?: boolean): Promise<{ generation: Generation }>;
  /**
   * Have the host ingest `name` on its own once the WAL waiting for ingest
   * passes `policy.maxWalBytes`, starting with what is already waiting,
   * hold its flushes and compactions to `policy.compactionMemoryBytes`, and
   * keep a reserve of `policy.reserveBytes`.
   */
  watch(name: string, policy: WatchPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  /**
   * The browser refused a WAL append of this tab: have the host release the
   * reserve of `name`. Resolves once the file is gone, whoever removed it,
   * and at once when the host keeps none.
   */
  makeRoom(name: string): Promise<void>;
  /**
   * Have the host record a manifest that pairs with the WAL of `name`
   * (design.md, "Recovery"), for a tab whose open or load found that the
   * recorded one does not. Resolves once it is recorded.
   */
  repair(name: string): Promise<void>;
  /** Delete every file and WAL record of `name`. See `Db.dangerousDestroy`. */
  destroy(name: string): Promise<void>;
  /** Host counters for `name`. Test and bench only. */
  stats(name: string): Promise<HostStats>;
  close(): void;
};
