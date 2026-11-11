import { afterEach, describe, expect, it } from "vitest";
import { openDb, StorageUnavailableError } from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
} from "../src/testing.js";

const NAME = "open-policy";
const enc = new TextEncoder();
const dec = new TextDecoder();

type Snap = {
  document: unknown;
  SharedWorker: unknown;
  navigator: Navigator;
};

function snap(): Snap {
  return {
    document: globalThis.document,
    SharedWorker: globalThis.SharedWorker,
    navigator: globalThis.navigator,
  };
}

function putGlobal(key: "document" | "SharedWorker" | "navigator", value: unknown): void {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(prev: Snap): void {
  for (const key of ["document", "SharedWorker", "navigator"] as const) {
    const value = prev[key];
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      putGlobal(key, value);
    }
  }
}

function installDocument(): void {
  putGlobal("document", { nodeType: 9 });
}

function installCaps(getDirectory: () => Promise<never>): void {
  putGlobal("SharedWorker", class SharedWorker {});
  putGlobal("navigator", {
    storage: { getDirectory },
  });
}

async function deleteIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const saved = snap();

afterEach(async () => {
  restore(saved);
  __resetMemoryFsForTests(NAME);
  await deleteIdb();
});

describe("openDb storage policy", () => {
  it("rejects where there is no document and no OPFS, as in Node", async () => {
    expect(typeof document).toBe("undefined");
    await expect(openDb({ name: NAME })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("rejects in a context with OPFS and no SharedWorker, as in a dedicated WebWorker", async () => {
    installCaps(() => Promise.reject(new Error("opfs-getDirectory")));
    Reflect.deleteProperty(globalThis, "SharedWorker");
    await expect(openDb({ name: NAME })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("throws StorageUnavailableError on a page that cannot open OPFS", async () => {
    installDocument();
    const opened = openDb({ name: NAME });
    await expect(opened).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(opened).rejects.toMatchObject({
      name: "StorageUnavailableError",
      code: "unavailable",
    });
  });

  it("a harness open that names no fs does not get memory either", async () => {
    await expect(openHarnessDb({ name: NAME, writerId: "w1" })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("forceMemory selects memory even when OPFS capabilities exist", async () => {
    installDocument();
    installCaps(() => Promise.reject(new Error("opfs-getDirectory")));
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    const got = await db.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");
    await db.close();
  });

  it("opens OPFS when both capabilities exist, with or without a document", async () => {
    installCaps(() => Promise.reject(new Error("opfs-getDirectory")));
    await expect(openDb({ name: NAME })).rejects.toThrow("opfs-getDirectory");
    installDocument();
    await expect(openDb({ name: NAME })).rejects.toThrow("opfs-getDirectory");
  });
});
