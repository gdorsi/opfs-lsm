import { kvStorage } from "@opfs-lsm/fate";
import { defineContender } from "../../core/types.ts";
import { recordSync } from "../../page/fate.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "fate",
  durability: "idb-default",
  fastPath:
    "@opfs-lsm/fate kvStorage(openDb): read = one get, writeBatch = one kv batch, scan = one range read, exclusive = a Web Lock plus db.sync(); persistence budget 1 GiB, nothing evicted",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    recordSync(db);
    return { ...kvCommon(db), storage: kvStorage(db) };
  },
});
