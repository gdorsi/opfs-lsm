import { KvPersistence } from "@opfs-lsm/yjs";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "KvPersistence from @opfs-lsm/yjs, every doc on one kv db: one put per update, one range scan per load, trim at 500 updates",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return {
      ...kvCommon(db),
      async attach(docName, doc) {
        const persistence = new KvPersistence(db, docName, doc);
        await persistence.whenSynced;
        return { flush: () => persistence.flush(), detach: () => persistence.destroy(), clear: () => persistence.clearData() };
      },
    };
  },
});
