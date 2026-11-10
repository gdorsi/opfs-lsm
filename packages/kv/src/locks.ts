/**
 * The Web Locks the database uses, one name per job:
 *
 * - `opfs-lsm-ingest/<db>`: every manifest publish, held by an ingest round,
 *   a compaction install and a reclaim, across every host of the origin.
 * - `opfs-lsm-compact/<db>`: one compaction pass, merges included, so a
 *   sweep never takes a run that is being written for an orphan.
 * - `opfs-lsm-reclaim/<db>`: shared while a tab loads a generation, so the
 *   host removes no manifest or run under it.
 * - `opfs-lsm-log/<db>/<log>`: held by the dedicated WebWorker that writes
 *   the log, for its whole life (`logLockName`).
 */

function locks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

/** Takes `name` if it is free and resolves with its release; undefined while another context holds it. */
export function tryLock(name: string): Promise<(() => void) | undefined> {
  return new Promise((granted, failed) => {
    locks()!
      .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          granted(undefined);
          return;
        }
        return new Promise<void>((release) => granted(release));
      })
      .catch(failed);
  });
}

/** Runs `fn` holding `name` exclusively, after every earlier request for it. */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const manager = locks();
  if (!manager) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return manager.request(name, fn) as unknown as Promise<T>;
}

export function ingestLock(name: string): string {
  return `opfs-lsm-ingest/${name}`;
}

export function compactLock(name: string): string {
  return `opfs-lsm-compact/${name}`;
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
