import "fake-indexeddb/auto";
import "../src/testing.js";
import { expect } from "vitest";

// `toEqual` walks a Uint8Array as a generic object, and the sims compare
// thousands of keys and values per history. Two arrays of the same class are
// equal when their bytes are; anything else falls through to the default.
expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined => {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return undefined;
    if (a.constructor !== b.constructor) return undefined;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },
]);

type RawStore = {
  keyGenerator: { num: number } | null;
  storeRecord(record: unknown, noOverwrite: boolean, rollbackLog?: (() => void)[]): unknown;
};

/**
 * IndexedDB reverts a key generator that an explicit key moved when the
 * transaction aborts (the spec's "Key generators", and design.md, assumption
 * 1). fake-indexeddb reverts only the keys it generated, so a refused WAL
 * append at an explicit seq would leave the next generated seq one past a
 * gap. This adds the missing revert to its object store, once.
 */
function revertExplicitKeysOnAbort(): void {
  const store = IDBObjectStore.prototype;
  const { put, add } = store;
  let patched = false;
  const patch = (objectStore: IDBObjectStore) => {
    if (patched) return;
    patched = true;
    const raw = Object.getPrototypeOf((objectStore as unknown as { _rawObjectStore: RawStore })._rawObjectStore) as RawStore;
    const storeRecord = raw.storeRecord;
    raw.storeRecord = function (this: RawStore, record, noOverwrite, rollbackLog) {
      const generator = this.keyGenerator;
      const before = generator?.num;
      const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
      if (generator && rollbackLog && before !== undefined && generator.num !== before) {
        rollbackLog.push(() => (generator.num = before));
      }
      return key;
    };
  };
  store.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    patch(this);
    return put.apply(this, args);
  };
  store.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
    patch(this);
    return add.apply(this, args);
  };
}
revertExplicitKeysOnAbort();
