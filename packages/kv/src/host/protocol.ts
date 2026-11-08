import type { ErrorCode } from "../errors.js";
import type { IngestPolicy } from "../ingest-policy.js";

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
      /** Ask the host to report the background WAL scan. Open does not wait for it. */
      readonly trace?: boolean;
    }
  | { readonly type: "unwatch"; readonly name: string }
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
   * passes `policy.maxWalBytes`, starting with what is already waiting.
   */
  watch(name: string, policy: IngestPolicy): void;
  /** This tab no longer needs the host to watch `name`. */
  unwatch(name: string): void;
  close(): void;
};
