/**
 * The model's wrapper around the caller's body storage. It never forwards
 * `close`, so `repo.shutdown()` leaves the caller's db open. It tracks the
 * saves in flight for each doc id, drops every save for a blocked id, and
 * remembers which ids failed to load.
 *
 * Keys are automerge-repo's: `[docId, "snapshot" | "incremental", hash]` for
 * doc chunks and `[docId, "sync-state", storageId]` for sync state.
 */
import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo";

export type SaveEvent = "start" | "done" | "failed";
export type SaveListener = (event: SaveEvent, error?: unknown) => void;

export interface SaveFilter extends StorageAdapterInterface {
  /** Drops every save for `id` from now on. Saves already started still land. */
  block(id: string): void;
  /** Resolves once no save for `id` is in flight. */
  idle(id: string): Promise<void>;
  /** Reports each save of `id`'s chunks as it starts, synchronously, and as it settles. */
  watch(id: string, listener: SaveListener): () => void;
  /** Whether the last read of `id`'s chunks failed. */
  loadFailed(id: string): boolean;
}

type Entry = {
  saving: number;
  blocked: boolean;
  loadFailed: boolean;
  idle: (() => void)[];
  listeners: Set<SaveListener>;
};

export function saveFilter(inner: StorageAdapterInterface): SaveFilter {
  const entries = new Map<string, Entry>();
  const entry = (id: string): Entry => {
    let found = entries.get(id);
    if (!found) {
      found = { saving: 0, blocked: false, loadFailed: false, idle: [], listeners: new Set() };
      entries.set(id, found);
    }
    return found;
  };
  const docId = (key: StorageKey): string | undefined => (key.length > 1 ? key[0] : undefined);
  const isChunk = (key: StorageKey) => key[1] === "snapshot" || key[1] === "incremental";

  return {
    load: (key) => inner.load(key),
    remove: (key) => inner.remove(key),
    removeRange: (prefix) => inner.removeRange(prefix),

    async loadRange(prefix): Promise<Chunk[]> {
      const id = docId(prefix);
      if (id === undefined) return inner.loadRange(prefix);
      const e = entry(id);
      e.loadFailed = false;
      try {
        return await inner.loadRange(prefix);
      } catch (error) {
        e.loadFailed = true;
        throw error;
      }
    },

    async save(key, data) {
      const id = docId(key);
      if (id === undefined) return inner.save(key, data);
      const e = entry(id);
      if (e.blocked) return;
      const notify = isChunk(key) ? (event: SaveEvent, error?: unknown) => e.listeners.forEach((l) => l(event, error)) : () => {};
      e.saving++;
      notify("start");
      try {
        await inner.save(key, data);
        notify("done");
      } catch (error) {
        notify("failed", error);
        throw error;
      } finally {
        if (--e.saving === 0) for (const resolve of e.idle.splice(0)) resolve();
      }
    },

    block(id) {
      entry(id).blocked = true;
    },

    idle(id) {
      const e = entries.get(id);
      if (!e || e.saving === 0) return Promise.resolve();
      return new Promise((resolve) => e.idle.push(resolve));
    },

    watch(id, listener) {
      const listeners = entry(id).listeners;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    loadFailed: (id) => entries.get(id)?.loadFailed ?? false,
  };
}
