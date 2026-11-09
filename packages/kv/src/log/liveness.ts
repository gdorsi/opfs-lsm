import type { TabId } from "./frame.js";

/**
 * Which tabs of a database are alive. Each open Db holds the Web Lock
 * `opfs-lsm-tab/<name>/<tab>` for its whole life; the browser releases it
 * when the tab, or its worker, goes away, crash included. Without Web
 * Locks (old runtimes) an in-process registry stands in.
 */
function lockPrefix(name: string): string {
  return `opfs-lsm-tab/${name}/`;
}

function locks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

const local = new Map<string, Set<TabId>>();
/** Without Web Locks: who waits for a tab's lock to go, by `name/tab`. */
const localWaiters = new Map<string, (() => void)[]>();

/** Hold `tab`'s liveness lock. Resolves once held; call the result to release it. */
export async function holdTab(name: string, tab: TabId): Promise<() => void> {
  const manager = locks();
  if (!manager) {
    const set = local.get(name) ?? new Set<TabId>();
    local.set(name, set);
    set.add(tab);
    return () => {
      set.delete(tab);
      const key = `${name}/${tab}`;
      for (const wake of localWaiters.get(key) ?? []) wake();
      localWaiters.delete(key);
    };
  }
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await new Promise<void>((granted, failed) => {
    manager
      .request(lockPrefix(name) + tab, () => {
        granted();
        return held;
      })
      .catch(failed);
  });
  return release;
}

/** The tabs holding their liveness lock now. */
export async function liveTabs(name: string): Promise<Set<TabId>> {
  const manager = locks();
  if (!manager) return new Set(local.get(name) ?? []);
  const prefix = lockPrefix(name);
  const snapshot = await manager.query();
  const out = new Set<TabId>();
  for (const lock of snapshot.held ?? []) {
    if (lock.name?.startsWith(prefix)) out.add(lock.name.slice(prefix.length));
  }
  return out;
}

/**
 * Resolves once `tab` does not hold its liveness lock: it closed or died,
 * and wrote everything it ever will. For a tab that already let go, at once.
 */
export async function tabReleased(name: string, tab: TabId): Promise<void> {
  const manager = locks();
  if (!manager) {
    if (!local.get(name)?.has(tab)) return;
    const key = `${name}/${tab}`;
    await new Promise<void>((wake) => localWaiters.set(key, [...(localWaiters.get(key) ?? []), wake]));
    return;
  }
  await manager.request(lockPrefix(name) + tab, () => undefined);
}
