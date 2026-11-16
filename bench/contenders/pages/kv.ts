import { kvStorage } from "@opfs-lsm/automerge";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "pages",
  durability: "idb-default",
  fastPath: "kvStorage(openDb) from @opfs-lsm/automerge: the list doc and every page body on one kv db; save = put, loadRange = one range scan",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return { ...kvCommon(db), storage: kvStorage(db) };
  },
});
