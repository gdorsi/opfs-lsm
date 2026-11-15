import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { kvPagesStorage } from "../../../examples/pages-fate-automerge/src/storage/kv.ts";

export default defineContender({
  family: "pages",
  durability: "idb-default",
  fastPath:
    "kvPagesStorage(openDb): one kv db for fate (key prefix 0x66) and automerge bodies (length-framed keys); body save = put, loadRange = one range scan",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return { ...kvCommon(db), storage: kvPagesStorage(db) };
  },
});
