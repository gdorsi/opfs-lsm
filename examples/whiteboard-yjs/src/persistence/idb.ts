import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { DocBinding, DocStorage } from "../model/index.ts";

/**
 * Stores every doc in its own IndexedDB database, `<prefix>/<docName>`, as y-indexeddb does.
 *
 * y-indexeddb has no flush and reports no failed write, so this adds both. A flush waits on a write
 * transaction of its own, which completes after every update written before it. A write that failed
 * shows up as an error or abort event on the connection. The next flush then writes the whole doc
 * state again, and rejects if that write fails too, the way `KvPersistence.flush` repairs.
 */
export function idbStorage(prefix = "whiteboard"): DocStorage {
  return {
    async attach(docName: string, doc: Y.Doc): Promise<DocBinding> {
      const name = `${prefix}/${docName}`;
      const persistence = new IndexeddbPersistence(name, doc);
      // whenSynced never settles when the database cannot be opened, so race it with the open itself.
      const db = await Promise.race([persistence.whenSynced.then(() => persistence.db!), persistence._db.then(never)]);

      let failure: { readonly error: unknown } | undefined;
      const record = (event: Event) => {
        failure ??= { error: (event.target as IDBRequest | IDBTransaction).error ?? new Error("IndexedDB write failed") };
      };
      db.addEventListener("error", record);
      db.addEventListener("abort", record);

      let ended = false;
      const flush = async (): Promise<void> => {
        if (ended) return;
        await complete(db.transaction("updates", "readwrite")).catch((error: unknown) => void (failure ??= { error }));
        if (!failure) return;
        failure = undefined;
        try {
          const tx = db.transaction("updates", "readwrite");
          tx.objectStore("updates").add(Y.encodeStateAsUpdate(doc));
          await complete(tx);
        } catch (error) {
          failure = { error };
          throw error;
        }
      };
      return {
        flush,
        async detach() {
          try {
            await flush();
          } finally {
            ended = true;
            await persistence.destroy();
          }
        },
        async clear() {
          ended = true;
          await persistence.clearData();
          // clearData does not wait for its deleteDatabase. A second request for the same name completes after it.
          await request(indexedDB.deleteDatabase(name));
        },
      };
    },
  };
}

const never = (): Promise<never> => new Promise(() => {});

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
