import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";

let dbs = 0;

export function freshName(): string {
  return `db-${process.pid}-${++dbs}`;
}

/** One handle on `name`, on a memory file system. Handles on one name share the WAL and the run files, like tabs of one origin. */
export function openKv(name: string = freshName()): Promise<Db> {
  return openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
}

/** Resolves once `done()` holds, checked after each turn of the event loop. Rejects with `what` after two seconds. */
export async function until(done: () => boolean, what: string | (() => string) = "the condition"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** What a subscription was called with. */
export type Watch<V> = { readonly values: V[]; readonly errors: unknown[]; readonly stop: () => void };

export function watch<V>(live: { subscribe(next: (value: V) => void, error?: (error: Error) => void): () => void }): Watch<V> {
  const values: V[] = [];
  const errors: unknown[] = [];
  const stop = live.subscribe(
    (value) => values.push(value),
    (error) => errors.push(error),
  );
  return { values, errors, stop };
}

/**
 * `kv` whose views can be held: a held view takes its snapshot and reads,
 * and hands its result over only after `release`. `views` counts the calls.
 */
export function holdViews(kv: Db): { readonly db: Db; readonly views: () => number; hold(): void; release(): void; fail(error: Error | undefined): void } {
  let count = 0;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  let failure: Error | undefined;
  const view: Db["view"] = (body) => {
    count++;
    if (failure) return Promise.reject(failure);
    const held = gate;
    return kv.view(async (snap) => {
      const result = await body(snap);
      await held;
      return result;
    });
  };
  const db = new Proxy(kv, {
    get(target, prop) {
      if (prop === "view") return view;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return {
    db,
    views: () => count,
    hold() {
      gate = new Promise((resolve) => (open = resolve));
    },
    release() {
      open?.();
      gate = undefined;
    },
    fail(error) {
      failure = error;
    },
  };
}
