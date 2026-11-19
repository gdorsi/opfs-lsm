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
