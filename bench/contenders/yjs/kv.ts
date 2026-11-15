import { kvStorage } from "@opfs-lsm/example-whiteboard-yjs/persistence";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "examples/whiteboard-yjs kvStorage over KvPersistence: one put per update, one range scan per load, trim at 500 updates",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return { ...kvCommon(db), attach: kvStorage(db).attach };
  },
});
