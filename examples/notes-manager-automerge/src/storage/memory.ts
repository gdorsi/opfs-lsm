import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo";

/** Storage in a Map, for Node tests and the bench's `memory` contender, the floor a store's cost is measured from. */
export function memoryStorage(): StorageAdapterInterface {
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
