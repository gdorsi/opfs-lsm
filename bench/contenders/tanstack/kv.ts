import { kvCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import type { Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { collectionOps } from "../../page/tanstack.ts";

export default defineContender({
  family: "tanstack",
  durability: "idb-default",
  fastPath:
    "kvCollectionOptions on openDb; insert/update/delete with an array = one TanStack transaction = one kv batch; settled on tx.when('settled'); preload() reads the collection's range",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const todos = createCollection(kvCollectionOptions({ db: kv, name: "todos", getKey: (t: Todo) => t.id }));
    await todos.preload();
    const common = kvCommon(kv);
    return {
      ...common,
      ...collectionOps(todos),
      close: async () => {
        await todos.cleanup();
        await common.close();
      },
    };
  },
});
