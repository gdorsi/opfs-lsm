import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { createIndexedDBStorage } from "@nkzw/fate-indexeddb";
import type { PagesStorage } from "../model/types.ts";

/**
 * Each library keeps its own IndexedDB database, as it ships: fate-indexeddb
 * owns `<name>-fate` and automerge-repo's adapter owns `<name>-bodies`. Neither
 * can share a database with the other.
 */
export function indexedDbPagesStorage(name: string): PagesStorage {
  return {
    fate: createIndexedDBStorage({ name: `${name}-fate` }),
    bodies: new IndexedDBStorageAdapter(`${name}-bodies`),
  };
}
