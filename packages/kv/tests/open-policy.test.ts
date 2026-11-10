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
  Worker: unknown;
  navigator: Navigator;
};

function snap(): Snap {
  return {
    document: globalThis.document,
    SharedWorker: globalThis.SharedWorker,
    Worker: (globalThis as { Worker?: unknown }).Worker,
    navigator: globalThis.navigator,
  };
}

function putGlobal(key: keyof Snap, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(prev: Snap): void {
  for (const key of ["document", "SharedWorker", "Worker", "navigator"] as const) {
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
  putGlobal("Worker", class Worker {});
  putGlobal("navigator", {
    storage: { getDirectory },
    locks: saved.navigator.locks,
  });
}

async function roundTrip(): Promise<void> {
  const db = await openDb({ name: NAME });
  await db.put(enc.encode("k"), enc.encode("v"));
  const got = await db.get(enc.encode("k"));
  expect(got && dec.decode(got)).toBe("v");
  await db.close();
}

const saved = snap();

afterEach(() => {
  restore(saved);
  __resetMemoryFsForTests(NAME);
});

describe("openDb storage policy", () => {
  it("keeps the in-memory default when there is no document", async () => {
    expect(typeof document).toBe("undefined");
    await roundTrip();
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

  it("keeps the page in memory when allowEphemeral is set and OPFS is missing", async () => {
    installDocument();
    const db = await openHarnessDb({
      name: NAME,
      allowEphemeral: true,
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    const got = await db.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");
    await db.close();
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

  it("still opens OPFS when both capabilities exist and allowEphemeral is set", async () => {
    installDocument();
    installCaps(() => Promise.reject(new Error("opfs-getDirectory")));
    await expect(
      openHarnessDb({
        name: NAME,
        allowEphemeral: true,
      }),
    ).rejects.toThrow("opfs-getDirectory");
  });
});
