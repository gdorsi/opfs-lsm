import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";
import type { Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { onDemandOps } from "../../page/tanstack.ts";

const schema = defineSchema<{ todos: Todo }>()({
  version: 1,
  collections: { todos: { byOwner: { on: ["owner", "createdAt"] } } },
});

export default defineContender({
  family: "tanstack-ondemand",
  durability: "idb-default",
  fastPath:
    "docstoreCollectionOptions with syncMode on-demand on openDocStore on openDb; one docstore index byOwner on [owner, createdAt]; a live query loads its rows through that index, or by id; writes as in tanstack/kv",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const todos = createCollection(
      docstoreCollectionOptions({ collection: (await openDocStore(kv, schema)).collection("todos"), syncMode: "on-demand" }),
    );
    await todos.preload();
    const common = kvCommon(kv);
    return {
      ...common,
      ...onDemandOps(todos),
      close: async () => {
        await todos.cleanup();
        await common.close();
      },
    };
  },
});
