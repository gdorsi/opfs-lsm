import type { ErrorCode } from "../errors.js";
import type { IngestPolicy } from "../ingest-policy.js";
import type { IoCounters } from "../opfs/counting-fs.js";

/** What the host counted for one database since it started. Test and bench only. */
export type HostStats = {
  /** Flush (l0), compaction outputs (lN), manifests (m), compaction input reads. */
  fs: IoCounters;
  /** Ingests that folded at least one WAL record into an L0 run. */
  flushes: number;
  /** Compaction steps installed. */
  compactionSteps: number;
  /** Σ IngestResult.foldedBytes. */
  foldedBytes: number;
  generation: number;
  /** From the latest manifest, levels with at least one run. */
  layout: { level: number; runs: number; bytes: number }[];
};

/** The BroadcastChannel for new generations and ingest requests: tabs and the host. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

/**
 * The BroadcastChannel where tabs' log sessions share records and promises.
 * Only sessions listen: a record carries its ops, and every listener pays
 * to copy them.
 */
export function logChannel(name: string): string {
  return `opfs-lsm-log/${name}`;
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
      readonly cut: number;
      readonly settle: boolean;
    }
  | {
      readonly type: "watch";
      readonly name: string;
      readonly maxWalBytes: number;
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
  | { readonly type: "stats-ok"; readonly id: number; readonly stats: HostStats }
  | { readonly type: "pong"; readonly id: number };

export type IngestClient = {
  /**
   * Fold every log record stamped at or below `cut` into the SSTs. The
   * caller's watermark passed `cut`. A no-op when the committed generation
   * covers it. With `settle`, resolve once compaction has finished too.
   */
  ingest(
    name: string,
    cut: number,
    settle?: boolean,
  ): Promise<{ generation: number }>;
  /**
   * Have the host ingest `name` on its own when a tab asks for a cut
   * (`ingest-request` on `layersChannel`). Tabs ask once
   * `policy.maxWalBytes` of log became stable since the last cut.
   */
  watch(name: string, policy: IngestPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  /** Host counters for `name`. Test and bench only. */
  stats(name: string): Promise<HostStats>;
  close(): void;
};
