/** The Web Locks manager, or undefined where the platform has none. */
export function webLocks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

/** Run `fn` holding Web Lock `name`, or unprotected where the platform has none. */
export function withLock<T>(name: string, fn: () => Promise<T>, mode: LockMode = "exclusive"): Promise<T> {
  const locks = webLocks();
  if (!locks) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return locks.request(name, { mode }, fn) as unknown as Promise<T>;
}

/** The BroadcastChannel where tabs share appends and new generations. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

/**
 * Held shared by `openDb` from before it touches either store until it
 * resolves, and exclusively by `destroyDb` for its whole run. No handle
 * holds it while open: `destroyDb` waits on the handles' IndexedDB
 * connections instead. Lock order everywhere: open, compaction, ingest.
 */
export function openLock(name: string): string {
  return `opfs-lsm-open/${name}`;
}

export function reclaimLock(name: string): string {
  return `opfs-lsm-reclaim/${name}`;
}

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

export function compactLock(name: string): string {
  return `opfs-lsm-compact/${name}`;
}

/** Held by the one handle that answers the host's offers when storage is full, while it has a handler. */
export function fullLock(name: string): string {
  return `opfs-lsm-full/${name}`;
}

export function ingestLock(name: string): string {
  return `opfs-lsm-ingest/${name}`;
}

/** Held shared while a reader has the run open; the host removes it only when it can take it exclusively. */
export function runLock(dbName: string, path: string): string {
  return `opfs-lsm:${dbName}:run:${path}`;
}
