/**
 * A hand-written IndexedDB key-value store doing the same ops as kv: one
 * object store with binary keys, one readwrite transaction per batch,
 * getAll(range, limit) for scans. Default durability, like kv's WAL.
 */
import { defineContender } from "../../core/types.ts";
import { done, openIdb, request } from "../../page/idb.ts";

const STORE = "kv";
/** kv bytes are always ArrayBuffer-backed; TypeScript's IDBValidKey wants that spelled out. */
const k = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export default defineContender({
  family: "kv",
  durability: "idb-default",
  fastPath: "one object store, binary keys; putMany = one readwrite tx; range = getAll(bound, limit)",
  engine: false,
  async open(name) {
    const db = await openIdb(`idb-${name}`, (d) => d.createObjectStore(STORE));
    const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
      async putMany(entries) {
        const s = store("readwrite");
        for (const [key, v] of entries) s.put(v, k(key));
        await done(s.transaction);
      },
      async deleteMany(keys) {
        const s = store("readwrite");
        for (const key of keys) s.delete(k(key));
        await done(s.transaction);
      },
      async get(key) {
        return request<Uint8Array | undefined>(store("readonly").get(k(key)));
      },
      async range(start, endExclusive, limit) {
        const bound = endExclusive ? IDBKeyRange.bound(k(start), k(endExclusive), false, true) : IDBKeyRange.lowerBound(k(start));
        return request<Uint8Array[]>(store("readonly").getAll(bound, limit));
      },
      async update(key, f) {
        const s = store("readwrite");
        const old = await request<Uint8Array | undefined>(s.get(k(key)));
        s.put(f(old), k(key));
        await done(s.transaction);
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => db.close(),
    };
  },
});
