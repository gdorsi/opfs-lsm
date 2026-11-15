import { idbStorage } from "@opfs-lsm/example-whiteboard-yjs/persistence";
import { defineContender } from "../../core/types.ts";
import type { YjsBinding } from "../../core/families.ts";

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "examples/whiteboard-yjs idbStorage over y-indexeddb: one IndexedDB database per doc, one tx per update, trim at 500",
  engine: false,
  async open(name) {
    const storage = idbStorage(name);
    const live = new Set<YjsBinding>();
    return {
      async attach(docName, doc) {
        const binding = await storage.attach(docName, doc);
        live.add(binding);
        return {
          flush: binding.flush,
          detach: async () => {
            live.delete(binding);
            await binding.detach();
          },
          clear: async () => {
            live.delete(binding);
            await binding.clear();
          },
        };
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        for (const binding of live) await binding.detach();
        live.clear();
      },
    };
  },
});
