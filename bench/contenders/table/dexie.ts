import Dexie, { type Table } from "dexie";
import { TODO_TABLE, type Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";


export default defineContender({
  family: "table",
  durability: "idb-default",
  fastPath: "Dexie 4; bulkPut; bulkGet; where().equals(); where().aboveOrEqual().limit(); rw transaction for update; bulkDelete",
  engine: false,
  async open(name) {
    const db = new Dexie(`dexie-${name}`);
    db.version(1).stores({ [TODO_TABLE]: "id, owner, createdAt" });
    await db.open();
    const t = db.table(TODO_TABLE) as Table<Todo, string>;
    return {
      putMany: async (rows) => {
        await t.bulkPut(rows as Todo[]);
      },
      put: async (row) => {
        await t.put(row);
      },
      get: (id) => t.get(id),
      getMany: (ids) => t.bulkGet(ids as string[]),
      whereOwner: (owner) => t.where("owner").equals(owner).toArray(),
      pageByCreated: (from, limit) => t.where("createdAt").aboveOrEqual(from).limit(limit).toArray(),
      update: (id, f) =>
        db.transaction("rw", t, async () => {
          const row = await t.get(id);
          if (row) await t.put(f(row));
        }),
      deleteMany: (ids) => t.bulkDelete(ids as string[]),
      settle: async () => {},
      stats: async () => undefined,
      close: async () => db.close(),
    };
  },
});
