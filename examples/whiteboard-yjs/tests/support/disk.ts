import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { KvPersistence } from "@opfs-lsm/yjs";
import * as Y from "yjs";
import type { DocStorage } from "../../src/model/index.ts";
import { kvStorage, memoryStorage } from "../../src/persistence/index.ts";

export const BACKENDS = ["memory", "kv"] as const;
export type Backend = (typeof BACKENDS)[number];

/**
 * The adapter the suites run on: WB_STORAGE=kv, and memory when unset. Every suite that only needs a working
 * storage asks `disk()` for one, so the same file reruns on each adapter.
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
  const made = which === "memory" ? memoryDisk() : kvDisk();
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
