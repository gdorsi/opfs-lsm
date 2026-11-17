import { IndexeddbPersistence } from "y-indexeddb";
import { defineContender } from "../../core/types.ts";
import type { YjsBinding } from "../../core/families.ts";

/** y-indexeddb has no flush: a readwrite transaction on its store completes after every update written before it. */
function flushOf(persistence: IndexeddbPersistence): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      const tx = persistence.db!.transaction("updates", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
}

export default defineContender({
  family: "yjs",
  durability: "idb-default",
  fastPath: "y-indexeddb: one IndexedDB database per doc, one transaction per update, trim at 500",
  engine: false,
  async open(name) {
    const live = new Set<YjsBinding>();
    return {
      async attach(docName, doc) {
        const dbName = `${name}/${docName}`;
        const persistence = new IndexeddbPersistence(dbName, doc);
        await persistence.whenSynced;
        const flush = flushOf(persistence);
        const binding: YjsBinding = {
          flush,
          async detach() {
            live.delete(binding);
            await flush();
            await persistence.destroy();
          },
          async clear() {
            live.delete(binding);
            await persistence.clearData();
            // clearData does not wait for its deleteDatabase; a second request for the same name completes after it.
            await new Promise<void>((resolve, reject) => {
              const req = indexedDB.deleteDatabase(dbName);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(req.error);
            });
          },
        };
        live.add(binding);
        return binding;
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => {
        for (const binding of [...live]) await binding.detach();
      },
    };
  },
});
