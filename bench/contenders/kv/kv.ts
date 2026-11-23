import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "kv",
  durability: "idb-default",
  fastPath: "openDb (SharedWorker host); putMany = one db.batch; getMany = db.getMany; range = db.range, with its offset and direction; count = db.count; update = db.update",
  engine: true,
  async open(name) {
    const db = await openKv(name);
    return {
      ...kvCommon(db),
      putMany: async (entries) => {
        await db.batch((tx) => {
          for (const [k, v] of entries) tx.put(k, v);
        });
      },
      deleteMany: async (keys) => {
        await db.batch((tx) => {
          for (const k of keys) tx.delete(k);
        });
      },
      get: (key) => db.get(key),
      getMany: (keys) => db.getMany(keys),
      async range(start, endExclusive, limit, offset = 0, reverse = false) {
        const values: Uint8Array[] = [];
        for await (const e of db.range({ start, ...(endExclusive ? { endExclusive } : {}), limit, offset, reverse })) values.push(e.value);
        return values;
      },
      count: (start, endExclusive) => db.count({ start, endExclusive }),
      update: (key, f) =>
        db.update([key], ([old], tx) => {
          tx.put(key, f(old));
        }),
    };
  },
});
