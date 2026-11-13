import { createIndexedDBStorage } from "@nkzw/fate-indexeddb";
import { defineContender } from "../../core/types.ts";

export default defineContender({
  family: "fate",
  durability: "idb-default",
  fastPath:
    "@nkzw/fate-indexeddb createIndexedDBStorage: one object store; read = one get, writeBatch = one readwrite transaction, scan = getAllKeys and getAll in one transaction, exclusive = a Web Lock; persistence budget 1 GiB, nothing evicted",
  engine: false,
  async open(name) {
    const storage = createIndexedDBStorage({ name: `fate-${name}` });
    // The database opens on the first call, and again whenever the last call has ended; pay the first open inside the timed open, as kv does.
    await storage.read("__bench_open__");
    // The adapter closes its connection when no call is running, so an idle store holds none and there is nothing to close.
    return { storage, settle: async () => {}, stats: async () => undefined, close: async () => {} };
  },
});
