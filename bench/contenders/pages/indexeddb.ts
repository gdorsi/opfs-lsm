import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { defineContender } from "../../core/types.ts";

export default defineContender({
  family: "pages",
  durability: "idb-default",
  fastPath: "automerge-repo IndexedDBStorageAdapter: the list doc and every page body in one IndexedDB database, one tx per save",
  engine: false,
  async open(name) {
    const storage = new IndexedDBStorageAdapter(`pages-${name}`);
    await storage.load(["__bench_open__"]);
    return { storage, settle: async () => {}, stats: async () => undefined, close: () => storage.close() };
  },
});
