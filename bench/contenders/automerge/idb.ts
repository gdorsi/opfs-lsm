import { IndexedDBStorageAdapter } from "@automerge/react";
import { defineContender } from "../../core/types.ts";

export default defineContender({
  family: "automerge",
  durability: "idb-default",
  fastPath: "automerge-repo IndexedDBStorageAdapter (one object store, one tx per save)",
  engine: false,
  async open(name) {
    const adapter = new IndexedDBStorageAdapter(`am-${name}`);
    // The constructor starts the open without waiting for it; one load waits, so the open is paid inside the timed open, as kv's is.
    await adapter.load(["__bench_open__"]);
    return { adapter, settle: async () => {}, stats: async () => undefined, close: () => adapter.close() };
  },
});
