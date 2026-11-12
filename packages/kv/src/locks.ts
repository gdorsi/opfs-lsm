/** The Web Locks manager, or undefined where the platform has none. */
export function webLocks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

/** The BroadcastChannel where tabs share appends and new generations. */
export function layersChannel(name: string): string {
  return `opfs-lsm-layers/${name}`;
}

export function reclaimLock(name: string): string {
  return `opfs-lsm-reclaim/${name}`;
}

export function compactLock(name: string): string {
  return `opfs-lsm-compact/${name}`;
}

/** Held by the one handle that answers pressure offers, while it has a handler. */
export function pressureLock(name: string): string {
  return `opfs-lsm-pressure/${name}`;
}

export function ingestLock(name: string): string {
  return `opfs-lsm-ingest/${name}`;
}

/** Held shared while a reader has the run open; the host removes it only when it can take it exclusively. */
export function runLock(dbName: string, path: string): string {
  return `opfs-lsm:${dbName}:run:${path}`;
}
