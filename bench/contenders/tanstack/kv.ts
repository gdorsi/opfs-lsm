import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import type { Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { collectionOps } from "../../page/tanstack.ts";

const schema = defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: {} } });

export default defineContender({
  family: "tanstack",
  durability: "idb-default",
  fastPath:
    "docstoreCollectionOptions on openDocStore on openDb; insert/update/delete with an array = one TanStack transaction = one putMany, deleteMany or modifyMany = one kv update; settled on tx.when('settled'); preload() reads the collection from one view",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const todos = createCollection(docstoreCollectionOptions({ collection: (await openDocStore(kv, schema)).collection("todos") }));
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
