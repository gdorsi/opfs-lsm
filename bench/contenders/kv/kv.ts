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
      putMany: (entries) =>
        db.batch((tx) => {
          for (const [k, v] of entries) tx.put(k, v);
        }),
      deleteMany: (keys) =>
        db.batch((tx) => {
          for (const k of keys) tx.delete(k);
        }),
      get: (key) => db.get(key),
      async range(start, endExclusive, limit) {
        const values: Uint8Array[] = [];
        for await (const e of db.range({ start, ...(endExclusive ? { endExclusive } : {}), limit })) values.push(e.value);
        return values;
      },
      update: (key, f) =>
        db.update([key], ([old], tx) => {
          tx.put(key, f(old));
        }),
    };
  },
});
