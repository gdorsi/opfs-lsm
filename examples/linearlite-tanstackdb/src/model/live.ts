import { createLiveQueryObserver, type Collection } from "@tanstack/db";
import type { Pause } from "./counts.ts";
import type { IssueDocs } from "./store.ts";

export type Unsubscribe = () => void;

/**
 * A value that changes. `get` returns the same object until the value changes, so React's `useSyncExternalStore` can
 * call it on every render. The first subscriber starts the work behind it and the last one stops it.
 */
export interface Live<T> {
  get(): T;
  subscribe(onChange: () => void): Unsubscribe;
}

/** A Live subscribed until `release`. `until` resolves with the first value that passes `test`. */
export interface Held<T> {
  get(): T;
  until(test: (value: T) => boolean): Promise<T>;
  release(): void;
}

export function hold<T>(live: Live<T>): Held<T> {
  const waiting = new Set<() => void>();
  const release = live.subscribe(() => {
    for (const check of waiting) check();
  });
  return {
    get: () => live.get(),
    until: (test) =>
      new Promise((resolve) => {
        const check = () => {
          const value = live.get();
          if (!test(value)) return;
          waiting.delete(check);
          resolve(value);
        };
        waiting.add(check);
        check();
      }),
    release,
  };
}

/** What the views read of a live query's snapshot, which keeps its identity until the query changes. */
export type Snapshot = {
  readonly data: unknown;
  readonly state: ReadonlyMap<unknown, unknown> | undefined;
  readonly isReady: boolean;
};

/** A collection's rows as `useLiveQuery` reads them. Its sync starts at the first read, as a render starts it there. */
export type Observed = { snapshot(): Snapshot; subscribe(onChange: () => void): Unsubscribe };

export function observe<T extends object, K extends string | number>(collection: Collection<T, K, any, any, any>): Observed {
  const observer = createLiveQueryObserver(collection, { mode: "wholesale" });
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    collection.startSyncImmediate();
  };
  return {
    snapshot() {
      start();
      return observer.getSnapshot();
    },
    subscribe(onChange) {
      start();
      return observer.subscribe(() => onChange());
    },
  };
}

/** `compute`, run again only when an argument is not the same value as the last time. */
export function memo<A extends readonly unknown[], T>(compute: (...args: A) => T): (...args: A) => T {
  let last: { readonly args: A; readonly value: T } | undefined;
  return (...args) => {
    if (last && args.every((a, i) => Object.is(a, last!.args[i]))) return last.value;
    last = { args, value: compute(...args) };
    return last.value;
  };
}

/** A Live over live queries: `compute` runs again only after one of their snapshots changed. */
export function fromSnapshots<T>(sources: readonly Observed[], compute: (...snapshots: Snapshot[]) => T): Live<T> {
  const value = memo(compute);
  return {
    get: () => value(...sources.map((s) => s.snapshot())),
    subscribe(onChange) {
      const offs = sources.map((s) => s.subscribe(onChange));
      return () => {
        for (const off of offs) off();
      };
    },
  };
}

/** The listeners of one view. `start` runs at the first subscribe, and what it returns at the last unsubscribe. */
export function listeners(start: (notify: () => void) => Unsubscribe) {
  const all = new Set<() => void>();
  let stop: Unsubscribe | undefined;
  const notify = () => {
    for (const l of all) l();
  };
  return {
    notify,
    subscribe(onChange: () => void): Unsubscribe {
      all.add(onChange);
      if (all.size === 1) stop = start(notify);
      return () => {
        if (!all.delete(onChange) || all.size > 0) return;
        stop?.();
        stop = undefined;
      };
    },
  };
}

export type Read<T> = (issues: IssueDocs, pause?: Pause) => Promise<T>;

const yieldTask: Pause = () => new Promise((resolve) => setTimeout(resolve));

/**
 * Runs `read` of the stored issues now, and again after every change to them. One read runs at a time. Changes during
 * a read start one more, four times that read's duration after it and at least 250 ms, so a first sync, which changes
 * the issues every few milliseconds, spends at most a fifth of the main thread counting them. A read after a change
 * pauses between steps, so it does not hold up a frame, unless the page is `hidden`: a hidden page paints nothing and
 * wakes its timers about once a second. The first read does not pause, since the screen waits on it.
 */
export function recount<T>(issues: IssueDocs, read: Read<T>, emit: (value: T) => void, hidden: () => boolean): Unsubscribe {
  let live = true;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pauseUnlessHidden = () => (hidden() ? undefined : yieldTask);
  const run = async (pause?: Pause) => {
    timer = undefined;
    running = true;
    again = false;
    const t0 = performance.now();
    try {
      const value = await read(issues, pause);
      if (live) emit(value);
    } catch (err) {
      console.warn("linearlite could not count issues", err);
    }
    running = false;
    if (live && again) timer = setTimeout(() => void run(pauseUnlessHidden()), Math.max(250, 4 * (performance.now() - t0)));
  };
  const off = issues.changes((event) => {
    if (event.kind === "closed") return;
    if (running || timer !== undefined) again = true;
    else void run(pauseUnlessHidden());
  });
  void run();
  return () => {
    live = false;
    clearTimeout(timer);
    off();
  };
}

/**
 * Reads of the stored issues kept current while subscribed, one per key however many subscribe. The last unsubscribe
 * stops a read a microtask later, so a view that replaces another under the same key, as a list made again for
 * another sort does with its total, keeps the value instead of counting again.
 */
export function issueReads(issues: IssueDocs, hidden: () => boolean) {
  type Entry = { value: unknown; readonly listeners: Set<() => void>; stop: Unsubscribe };
  const entries = new Map<string, Entry>();
  return <T>(key: string, read: Read<T>): Live<T | undefined> => ({
    get: () => entries.get(key)?.value as T | undefined,
    subscribe(onChange) {
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = { value: undefined, listeners: new Set(), stop: () => {} };
        entries.set(key, created);
        created.stop = recount(
          issues,
          read,
          (value) => {
            created.value = value;
            for (const l of created.listeners) l();
          },
          hidden,
        );
        entry = created;
      }
      const mine = entry;
      mine.listeners.add(onChange);
      return () => {
        mine.listeners.delete(onChange);
        queueMicrotask(() => {
          if (mine.listeners.size > 0 || entries.get(key) !== mine) return;
          mine.stop();
          entries.delete(key);
        });
      };
    },
  });
}
