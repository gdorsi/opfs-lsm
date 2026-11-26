import { createLiveQueryCollection, createLiveQueryObserver, type Collection } from "@tanstack/db";
import type { SyncState } from "../domain/model.ts";
import type { Unsubscribe } from "./backend.ts";
import type { Linearlite } from "./index.ts";
import { syncRow } from "./query.ts";
import { pressureOf, syncStatus, type Pressure, type SyncStatus } from "./sync.ts";

/** A live query subscribed as a screen holds it, until `release`. `read` returns what `useLiveQuery` would. */
export type Shown<R> = { read(): { readonly data: R; readonly isReady: boolean }; readonly collection: Collection<any, any, any>; release: Unsubscribe };

export function show<R>(collection: Collection<any, any, any>): Shown<R> {
  const observer = createLiveQueryObserver(collection, { mode: "wholesale" });
  collection.startSyncImmediate();
  const release = observer.subscribe(() => {});
  return { read: () => observer.getSnapshot() as { data: R; isReady: boolean }, collection, release };
}

/** The last value a backend watch emitted, while subscribed. */
export function watched<T>(watch: (emit: (value: T) => void) => Unsubscribe): { read(): T | undefined; release: Unsubscribe } {
  let last: T | undefined;
  const release = watch((value) => (last = value));
  return { read: () => last, release };
}

/** Resolves with `read()` once it passes `test`; rejects with the last value after `ms`. */
export async function until<T>(read: () => T, test: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (test(value)) return value;
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)} after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The status bar and the storage alert as the app's hooks read them, until `release`. */
export function syncView(model: Linearlite): { status(): SyncStatus; pressure(): Pressure; release: Unsubscribe } {
  const row = show<SyncState | undefined>(createLiveQueryCollection({ query: syncRow(model.collections.sync), gcTime: 1 }));
  const [issues, bodies, comments] = [model.sync.outbox.issues, model.sync.outbox.bodies, model.sync.outbox.comments].map((c) => show<readonly unknown[]>(c));
  const unsent = () => bodies!.read().data.length + comments!.read().data.length;
  return {
    status: () => syncStatus(row.read().data, issues!.read().data.length + unsent()),
    pressure: () => pressureOf(row.read().data, unsent()),
    release() {
      for (const shown of [row, issues!, bodies!, comments!]) shown.release();
    },
  };
}
