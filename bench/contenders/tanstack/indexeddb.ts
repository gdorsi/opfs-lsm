import { createCollection, createIndexedDB, indexedDBCollectionOptions } from "@tanstack/db";
import type { Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { collectionOps } from "../../page/tanstack.ts";

export default defineContender({
  family: "tanstack",
  durability: "idb-default",
  fastPath:
    "indexedDBCollectionOptions on createIndexedDB; insert/update/delete with an array = one TanStack transaction = one IndexedDB readwrite transaction (rows plus version stamps); settled on tx.when('settled'); preload() getAll",
  engine: false,
  async open(name) {
    const idb = await createIndexedDB({ name: `tanstack-${name}`, version: 1, stores: ["todos"] });
    const todos = createCollection(indexedDBCollectionOptions({ db: idb, name: "todos", getKey: (t: Todo) => t.id }));
    await todos.preload();
    return {
      ...collectionOps(todos),
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        await todos.cleanup();
        idb.close();
      },
    };
  },
});
