import { openKvBackend, KV_PATH } from "../../../examples/linearlite-tanstackdb/src/backends/kv.ts";
import { defineContender } from "../../core/types.ts";
import { describePath } from "../../page/linearlite.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "linearlite",
  durability: "idb-default",
  fastPath: describePath(KV_PATH),
  engine: true,
  async open(name) {
    const db = await openKv(name);
    const backend = await openKvBackend(db, { hidden: () => document.hidden });
    const common = kvCommon(db);
    return {
      ...common,
      backend,
      close: async () => {
        await backend.close();
        await common.close();
      },
    };
  },
});
