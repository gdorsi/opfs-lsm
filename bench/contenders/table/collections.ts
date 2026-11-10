import { openCollectionDb } from "@opfs-lsm/collections";
import { CREATED_INDEX, OWNER_INDEX, TODO_TABLE, type Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { assertWasm, kvCommon } from "../../page/kv.ts";

export default defineContender({
  family: "table",
  durability: "log-write",
  fastPath: "openCollectionDb; putMany (one kv update per batch); where / orderBy on declared indexes; Promise.all for many gets and deletes",
  engine: true,
  async open(name) {
    const cdb = await openCollectionDb({
      name,
      schema: {
        tables: [
          {
            name: TODO_TABLE,
            indexes: [
              { name: OWNER_INDEX, path: "owner" },
              { name: CREATED_INDEX, path: "createdAt" },
            ],
          },
        ],
      },
    });
    await assertWasm();
    const t = cdb.table<Todo>(TODO_TABLE);
    return {
      ...kvCommon(cdb.kv),
      putMany: (rows) => t.putMany(rows),
      put: async (row) => {
        await t.put(row);
      },
      get: (id) => t.get(id),
      getMany: (ids) => Promise.all(ids.map((id) => t.get(id))),
      whereOwner: (owner) => t.where(OWNER_INDEX, owner),
      pageByCreated: (from, limit) => t.orderBy(CREATED_INDEX, { from, limit }),
      update: async (id, f) => {
        await t.update(id, f);
      },
      deleteMany: async (ids) => {
        await Promise.all(ids.map((id) => t.delete(id)));
      },
    };
  },
});
