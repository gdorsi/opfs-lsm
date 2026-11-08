import { IndexedDBStorageAdapter } from "@automerge/react";
import { defineContender } from "../../core/types.ts";

export default defineContender({
  family: "automerge",
  durability: "idb-default",
  fastPath: "automerge-repo IndexedDBStorageAdapter (one object store, one tx per save)",
  engine: false,
  async open(name) {
    const adapter = new IndexedDBStorageAdapter(`am-${name}`);
    // The adapter opens lazily; pay the open inside the timed open, as kv does.
    await adapter.load(["__bench_open__"]);
    return { adapter, settle: async () => {}, stats: async () => undefined, close: () => adapter.close() };
  },
});
