/**
 * A hand-written IndexedDB key-value store doing the same ops as kv: one
 * object store with binary keys, one readwrite transaction per batch,
 * getAll(range, limit) for scans, with a direction in reverse, count(range) for counts. Default durability, like kv's WAL.
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
/** `getAll` takes a direction since Chrome 141, in an options object TypeScript's DOM types do not have yet. */
type DirectedStore = {
  getAll(options: { query: IDBKeyRange; count: number; direction: IDBCursorDirection }): IDBRequest<Uint8Array[]>;
};

export default defineContender({
  family: "kv",
  durability: "idb-default",
  fastPath: "one object store, binary keys; putMany = one readwrite tx with an explicit commit(); getMany = one readonly tx of gets; range = getAll(bound, limit), or getAll({ query, count, direction: prev }) in reverse, after a key cursor advance for an offset; count = count(bound)",
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
      async range(start, endExclusive, limit, offset = 0, reverse = false) {
        // An empty range: IDBKeyRange.bound throws a DataError on it.
        if (endExclusive && indexedDB.cmp(k(start), k(endExclusive)) >= 0) return [];
        const s = store("readonly");
        const boundFrom = (from: Uint8Array<ArrayBuffer>) =>
          endExclusive ? IDBKeyRange.bound(from, k(endExclusive), false, true) : IDBKeyRange.lowerBound(from);
        // IndexedDB has no offset: a key cursor advances past the entries, and the bulk read starts where it stopped.
        const skip = (range: IDBKeyRange, dir: IDBCursorDirection) =>
          new Promise<Uint8Array<ArrayBuffer> | undefined>((resolve, reject) => {
            const req = s.openKeyCursor(range, dir);
            let moved = false;
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              if (!req.result || moved) return resolve(req.result ? new Uint8Array(req.result.key as ArrayBuffer) : undefined);
              moved = true;
              req.result.advance(offset);
            };
          });
        if (reverse) {
          let range = boundFrom(k(start));
          if (offset > 0) {
            const at = await skip(range, "prev");
            if (at === undefined) return [];
            range = IDBKeyRange.bound(k(start), at);
          }
          return request<Uint8Array[]>((s as unknown as DirectedStore).getAll({ query: range, count: limit, direction: "prev" }));
        }
        let from = k(start);
        if (offset > 0) {
          const at = await skip(boundFrom(from), "next");
          if (at === undefined) return [];
          from = at;
        }
        return request<Uint8Array[]>(s.getAll(boundFrom(from), limit));
      },
      count: (start, endExclusive) => request(store("readonly").count(IDBKeyRange.bound(k(start), k(endExclusive), false, true))),
      // A transaction opened after another connection's commit reads it.
      sync: async () => {},
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
