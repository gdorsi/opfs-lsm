import type { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { defineContender } from "../../core/types.ts";
import { indexedDbPagesStorage } from "../../../examples/pages-fate-automerge/src/storage/indexeddb.ts";

export default defineContender({
  family: "pages",
  durability: "idb-default",
  fastPath:
    "two IndexedDB databases: @nkzw/fate-indexeddb createIndexedDBStorage for fate, automerge-repo IndexedDBStorageAdapter for bodies",
  engine: false,
  async open(name) {
    const storage = indexedDbPagesStorage(`pages-${name}`);
    // Both open lazily; pay the opens inside the timed open, as kv does.
    await Promise.all([storage.fate.read("__bench_open__"), storage.bodies.load(["__bench_open__"])]);
    const bodies = storage.bodies as IndexedDBStorageAdapter;
    return {
      storage,
      settle: async () => {},
      stats: async () => undefined,
      close: () => bodies.close(),
    };
  },
});
