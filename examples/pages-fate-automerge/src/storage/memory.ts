import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo";
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import type { PagesStorage } from "../model/types.ts";

/** Body storage in a Map, for Node tests and the bench's `memory` contender. */
export function memoryBodies(): StorageAdapterInterface {
  const chunks = new Map<string, Chunk>();
  const name = (key: StorageKey) => JSON.stringify(key);
  const under = (prefix: StorageKey) => (chunk: Chunk) => prefix.every((segment, i) => chunk.key[i] === segment);
  return {
    async load(key) {
      return chunks.get(name(key))?.data;
    },
    async save(key, data) {
      chunks.set(name(key), { key, data });
    },
    async remove(key) {
      chunks.delete(name(key));
    },
    async loadRange(prefix) {
      return [...chunks.values()].filter(under(prefix));
    },
    async removeRange(prefix) {
      for (const chunk of [...chunks.values()].filter(under(prefix))) chunks.delete(name(chunk.key));
    },
  };
}

/** fate persistence storage in a Map. `exclusive` runs one caller at a time per name, as a Web Lock would. */
function memoryFate(): PersistenceStorage {
  const entries = new Map<string, unknown>();
  const tails = new Map<string, Promise<unknown>>();
  return {
    async read(key) {
      return entries.get(key);
    },
    async writeBatch(writes) {
      for (const [key, value] of writes) {
        if (value === undefined) entries.delete(key);
        else entries.set(key, value);
      }
    },
    async scan(prefix, after, limit = 64) {
      return [...entries.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key, value: entries.get(key) }));
    },
    exclusive(name, run) {
      const result = (tails.get(name) ?? Promise.resolve()).then(run);
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
}

/** The floor: both layers in Maps, so a contender minus this is what its storage costs. */
export function memoryPagesStorage(): PagesStorage {
  return { fate: memoryFate(), bodies: memoryBodies() };
}
