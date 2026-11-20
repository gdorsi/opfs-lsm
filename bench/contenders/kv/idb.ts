/**
 * A hand-written IndexedDB key-value store doing the same ops as kv: one
 * object store with binary keys, one readwrite transaction per batch,
 * getAll(range, limit) for scans, count(range) for counts. Default durability, like kv's WAL.
 *
 * Every write calls `commit()` once its requests are issued. Without it,
 * Chrome waits for the requests' success events to reach the tab before it
 * commits: one more round trip per transaction. kv's WAL commits the same way.
 */
import { defineContender } from "../../core/types.ts";
import { done, openIdb, request } from "../../page/idb.ts";

const STORE = "kv";
/** kv bytes are always ArrayBuffer-backed; TypeScript's IDBValidKey wants that spelled out. */
const k = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export default defineContender({
  family: "kv",
  durability: "idb-default",
  fastPath: "one object store, binary keys; putMany = one readwrite tx with an explicit commit(); getMany = one readonly tx of gets; range = getAll(bound, limit), after a key cursor advance for an offset; count = count(bound)",
  engine: false,
  async open(name) {
    const db = await openIdb(`idb-${name}`, (d) => d.createObjectStore(STORE));
    const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
      async putMany(entries) {
        const s = store("readwrite");
        for (const [key, v] of entries) s.put(v, k(key));
        s.transaction.commit();
        await done(s.transaction);
      },
      async deleteMany(keys) {
        const s = store("readwrite");
        for (const key of keys) s.delete(k(key));
        s.transaction.commit();
        await done(s.transaction);
      },
      async get(key) {
        return request<Uint8Array | undefined>(store("readonly").get(k(key)));
      },
      async getMany(keys) {
        const s = store("readonly");
        return Promise.all(keys.map((key) => request<Uint8Array | undefined>(s.get(k(key)))));
      },
      async range(start, endExclusive, limit, offset = 0) {
        const s = store("readonly");
        const boundFrom = (from: Uint8Array<ArrayBuffer>) =>
          endExclusive ? IDBKeyRange.bound(from, k(endExclusive), false, true) : IDBKeyRange.lowerBound(from);
        let from = k(start);
        if (offset > 0) {
          // IndexedDB has no offset: a key cursor advances past the entries, then getAll reads from where it stopped.
          const at = await new Promise<IDBValidKey | undefined>((resolve, reject) => {
            const req = s.openKeyCursor(boundFrom(from));
            let moved = false;
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              if (!req.result || moved) return resolve(req.result?.key);
              moved = true;
              req.result.advance(offset);
            };
          });
          if (at === undefined) return [];
          from = new Uint8Array(at as ArrayBuffer);
        }
        return request<Uint8Array[]>(s.getAll(boundFrom(from), limit));
      },
      count: (start, endExclusive) => request(store("readonly").count(IDBKeyRange.bound(k(start), k(endExclusive), false, true))),
      async update(key, f) {
        const s = store("readwrite");
        const old = await request<Uint8Array | undefined>(s.get(k(key)));
        s.put(f(old), k(key));
        s.transaction.commit();
        await done(s.transaction);
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => db.close(),
    };
  },
});
