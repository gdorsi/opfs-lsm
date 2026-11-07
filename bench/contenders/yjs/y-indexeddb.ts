import { IndexeddbPersistence } from "y-indexeddb";
import { defineContender } from "../../core/types.ts";
import { done } from "../../page/idb.ts";

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "y-indexeddb IndexeddbPersistence: one IndexedDB database per doc, one tx per update, trim at 500",
  engine: false,
  async open(name) {
    const live = new Set<IndexeddbPersistence>();
    return {
      async attach(docName, doc) {
        const p = new IndexeddbPersistence(`${name}/${docName}`, doc);
        live.add(p);
        await p.whenSynced;
        return {
          // y-indexeddb has no flush. Transactions on one store complete in order,
          // so a readwrite transaction opened now completes after every earlier write.
          async flush() {
            const db = await (p as unknown as { _db: Promise<IDBDatabase> })._db;
            await done(db.transaction("updates", "readwrite"));
          },
          async detach() {
            live.delete(p);
            await p.destroy();
          },
        };
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        for (const p of live) await p.destroy();
        live.clear();
      },
    };
  },
});
