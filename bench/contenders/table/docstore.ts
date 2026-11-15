import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { CREATED_INDEX, OWNER_INDEX, TODO_TABLE, type Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

const schema = defineSchema<{ [TODO_TABLE]: Todo }>()({
  version: 1,
  collections: {
    [TODO_TABLE]: {
      [OWNER_INDEX]: { by: "owner" },
      [CREATED_INDEX]: { by: "createdAt" },
    },
  },
});

export default defineContender({
  family: "table",
  durability: "idb-default",
  fastPath: "openDocStore on openDb; putMany and deleteMany (one kv update each); getMany; query on declared indexes; modify",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const todos = (await openDocStore(kv, schema)).collection(TODO_TABLE);
    return {
      ...kvCommon(kv),
      putMany: (rows) => todos.putMany(rows),
      put: (row) => todos.put(row),
      get: (id) => todos.get(id),
      getMany: (ids) => todos.getMany(ids),
      whereOwner: async (owner) => (await todos.query({ index: OWNER_INDEX, eq: [owner] })).docs,
      pageByCreated: async (from, limit) => (await todos.query({ index: CREATED_INDEX, gte: from, limit })).docs,
      update: async (id, f) => {
        await todos.modify(id, f);
      },
      deleteMany: async (ids) => {
        await todos.deleteMany(ids);
      },
    };
  },
});
