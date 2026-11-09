import { KvPersistence } from "@opfs-lsm/yjs";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "examples/yjs KvPersistence: one put per update, one range scan per load, trim at 500 updates",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return {
      ...kvCommon(db),
      async attach(docName, doc) {
        const p = new KvPersistence(db, docName, doc);
        await p.whenSynced;
        return { flush: () => p.flush(), detach: () => p.destroy() };
      },
    };
  },
});
