import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { after, type TestContext } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { KvPersistence } from "@opfs-lsm/yjs";
import * as Y from "yjs";
import type { DocStorage } from "../../src/model/index.ts";
import { idbStorage, kvStorage, memoryStorage } from "../../src/persistence/index.ts";

export const BACKENDS = ["memory", "kv", "idb"] as const;
export type Backend = (typeof BACKENDS)[number];

/**
 * The adapter the suites run on: WB_STORAGE=kv or WB_STORAGE=idb, and memory when unset. Every suite that
 * only needs a working storage asks `disk()` for one, so the same file reruns on each adapter.
 */
const backend: Backend = parseBackend(process.env.WB_STORAGE);

function parseBackend(name: string | undefined): Backend {
  if (name === undefined || name === "") return "memory";
  const found = BACKENDS.find((b) => b === name);
  if (!found) throw new Error(`WB_STORAGE must be one of ${BACKENDS.join(", ")}, got ${name}`);
  return found;
}

/** A storage on its own empty disk, plus what a test needs to look at the disk and break it. */
export type Disk = {
  readonly storage: DocStorage;
  /** Whether the disk holds any stored data for this doc, read behind the storage's back. */
  holds(docName: string): Promise<boolean>;
  /** Makes every write fail, or stops doing so. Undefined where the disk cannot fail. */
  failWrites?: (failing: boolean) => void;
  close(): Promise<void>;
};

const open = new Set<Disk>();

/** A fresh disk. It is closed when the test file ends, so a test can still close its boards after its last assertion. */
export function disk(which: Backend = backend): Disk {
  const made = which === "memory" ? memoryDisk() : which === "kv" ? kvDisk() : idbDisk();
  open.add(made);
  return made;
}

after(async () => {
  const all = [...open];
  open.clear();
  for (const d of all) await d.close();
});

function memoryDisk(): Disk {
  const storage = memoryStorage();
  return {
    storage,
    holds: async (docName) => (storage.updates.get(docName)?.length ?? 0) > 0,
    close: async () => {},
  };
}

function kvDisk(): Disk {
  const ready = openHarnessDb({ name: `wb${randomUUID().replaceAll("-", "").slice(0, 20)}`, forceMemory: true });
  let failing = false;
  const flaky = ready.then(
    (db) =>
      new Proxy(db, {
        get(target, key) {
          if (key === "put" && failing) return () => Promise.reject(new Error("disk full"));
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db,
  );
  return {
    storage: { attach: async (docName, doc) => kvStorage(await flaky).attach(docName, doc) },
    async holds(docName) {
      const probe = new KvPersistence(await ready, docName, new Y.Doc(), Infinity);
      await probe.whenSynced;
      await probe.destroy();
      return probe.loadedUpdates > 0;
    },
    failWrites: (on) => void (failing = on),
    close: async () => (await ready).close(),
  };
}

function idbDisk(): Disk {
  const prefix = `wb${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const add = IDBObjectStore.prototype.add;
  let failing = false;
  // Adding under a key that is already taken fails asynchronously, the way a full disk fails a write.
  const failingAdd: typeof add = function (this: IDBObjectStore, value, _key) {
    return add.call(this, value, 1);
  };
  return {
    storage: idbStorage(prefix),
    async holds(docName) {
      const name = `${prefix}/${docName}`;
      if (!(await indexedDB.databases()).some((d) => d.name === name)) return false;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const count = db.transaction("updates", "readonly").objectStore("updates").count();
          count.onsuccess = () => resolve(count.result > 0);
          count.onerror = () => reject(count.error);
        });
      } finally {
        db.close();
      }
    },
    failWrites(on) {
      failing = on;
      IDBObjectStore.prototype.add = on ? failingAdd : add;
    },
    async close() {
      if (failing) IDBObjectStore.prototype.add = add;
    },
  };
}

/**
 * Takes over the unhandled rejections of one test and returns them. y-indexeddb leaves the rejection of a
 * failed update write unhandled, and the runner would fail the test for it.
 */
export function collectUnhandled(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => void seen.push(reason));
  t.after(() => {
    process.removeAllListeners("unhandledRejection");
    for (const listener of saved) process.on("unhandledRejection", listener);
  });
  return seen;
}
