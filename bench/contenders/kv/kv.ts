import { defineContender } from "../../core/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";

export default defineContender({
  family: "kv",
  durability: "idb-default",
  fastPath: "openDb (SharedWorker host); putMany = one db.batch; range = db.range; update = db.update",
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
      async range(start, endExclusive, limit) {
        const entries = await db.range({ start, ...(endExclusive ? { endExclusive } : {}), limit });
        return entries.map((e) => e.value);
      },
      update: (key, f) =>
        db.update([key], ([old], tx) => {
          tx.put(key, f(old));
        }),
    };
  },
});
