import { createQueryPersister } from "@opfs-lsm/tanstack-query";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "tanstack-query",
  durability: "idb-default",
  fastPath:
    "@opfs-lsm/tanstack-query createQueryPersister(openDb): one query = one kv entry of its JSON; getItem = one get, setItem = one put, entries = one range read",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return { ...kvCommon(db), persister: (options) => createQueryPersister(db, options) };
  },
});
