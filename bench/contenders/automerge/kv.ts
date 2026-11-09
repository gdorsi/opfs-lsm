import { kvStorage } from "@opfs-lsm/example-automerge/storage";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "automerge",
  durability: "opfs-log-lazy",
  fastPath: "examples/automerge-todo kvStorage(openDb): save = put, loadRange = one range scan",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return { ...kvCommon(db), adapter: kvStorage(db) };
  },
});
