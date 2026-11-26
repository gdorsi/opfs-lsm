import { afterEach, describe, expect, it } from "vitest";
import { openDb, StorageFullError, StorageUnavailableError } from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
} from "../src/testing.js";

const NAME = "open-policy";
const enc = new TextEncoder();
const dec = new TextDecoder();

const GLOBALS = ["document", "SharedWorker", "Worker", "navigator"] as const;
type Global = (typeof GLOBALS)[number];
type Snap = Record<Global, unknown>;

function snap(): Snap {
  return {
    document: globalThis.document,
    SharedWorker: globalThis.SharedWorker,
    Worker: globalThis.Worker,
    navigator: globalThis.navigator,
  };
}

function putGlobal(key: Global, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(prev: Snap): void {
  for (const key of GLOBALS) {
    const value = prev[key];
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      putGlobal(key, value);
    }
  }
}

function installDocument(): void {
  // A handle listens for the page becoming hidden, so the stand-in takes listeners.
  putGlobal("document", Object.assign(new EventTarget(), { nodeType: 9, visibilityState: "visible" }));
}

function installCaps(getDirectory: () => Promise<never>): void {
  // An open starts the worker while it looks the folder up, so the stand-in has a port.
  putGlobal(
    "SharedWorker",
    class SharedWorker {
      port = Object.assign(new EventTarget(), { start() {}, postMessage() {}, close() {} });
    },
  );
  putGlobal("Worker", class Worker {});
  putGlobal("navigator", {
    storage: { getDirectory },
  });
}

/** An OPFS folder held in memory: what a tab's open needs of one. */
class FakeDir {
  readonly children = new Map<string, FakeDir>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, (child = new FakeDir()));
    if (!child) throw new DOMException(name, "NotFoundError");
    return child;
  }
  async *entries(): AsyncIterableIterator<[string, unknown]> {
    yield* this.children.entries();
  }
}

function installFolder(): void {
  const root = new FakeDir();
  putGlobal("navigator", { locks: (saved.navigator as Navigator).locks, storage: { getDirectory: async () => root } });
}

/** Worker and SharedWorker stand-ins that count what the page does with them. */
function countWorkers(): { shared: number; dedicated: number; terminated: number } {
  const count = { shared: 0, dedicated: 0, terminated: 0 };
  putGlobal(
    "SharedWorker",
    class {
      port = Object.assign(new EventTarget(), { start() {}, postMessage() {}, close() {} });
      constructor() {
        count.shared++;
      }
    },
  );
  putGlobal(
    "Worker",
    class extends EventTarget {
      constructor() {
        super();
        count.dedicated++;
      }
      postMessage() {}
      terminate() {
        count.terminated++;
      }
    },
  );
  return count;
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

  it("rejects in a context with OPFS and no worker of either kind", async () => {
    installCaps(() => Promise.reject(new Error("opfs-getDirectory")));
    Reflect.deleteProperty(globalThis, "SharedWorker");
    Reflect.deleteProperty(globalThis, "Worker");
    await expect(openDb({ name: NAME })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("starts a dedicated Worker where there is no SharedWorker, as in Samsung Internet, and terminates it at close", async () => {
    installDocument();
    installFolder();
    const workers = countWorkers();
    Reflect.deleteProperty(globalThis, "SharedWorker");

    const db = await openDb({ name: NAME });
    await db.put(enc.encode("k"), enc.encode("v"));
    const got = await db.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");
    expect(workers).toEqual({ shared: 0, dedicated: 1, terminated: 0 });

    await db.close();
    expect(workers).toEqual({ shared: 0, dedicated: 1, terminated: 1 });
  });

  it("starts the SharedWorker and no dedicated Worker where both exist", async () => {
    installDocument();
    installFolder();
    const workers = countWorkers();

    const db = await openDb({ name: NAME });
    await db.close();
    expect(workers).toEqual({ shared: 1, dedicated: 0, terminated: 0 });
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

const insecure = (message: string) => new DOMException(message, "SecurityError");

const failure = (opening: Promise<unknown>) =>
  opening.then(
    () => undefined,
    (err: unknown) => err,
  );

describe("openDb where an API it needs is there and fails", () => {
  it("rejects with StorageUnavailableError when navigator.storage.getDirectory rejects, as in a Firefox private window", async () => {
    const cause = insecure("Security error when calling GetDirectory");
    installCaps(() => Promise.reject(cause));

    const failed = await failure(openDb({ name: NAME }));

    expect(failed).toBeInstanceOf(StorageUnavailableError);
    expect((failed as StorageUnavailableError).cause).toBe(cause);
  });

  it("rejects with StorageFullError when the refusal is a QuotaExceededError", async () => {
    const cause = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    installCaps(() => Promise.reject(cause));

    const failed = await failure(openDb({ name: NAME }));

    expect(failed).toBeInstanceOf(StorageFullError);
    expect((failed as StorageFullError).cause).toBe(cause);
  });

  it("rejects with StorageUnavailableError when new SharedWorker() throws, as on a page of an opaque origin", async () => {
    const cause = insecure("The operation is insecure.");
    putGlobal(
      "SharedWorker",
      class {
        constructor() {
          throw cause;
        }
      },
    );
    putGlobal("Worker", class {});
    const folder = { getDirectoryHandle: async () => folder };
    putGlobal("navigator", { storage: { getDirectory: async () => folder } });

    const failed = await failure(openDb({ name: NAME }));

    expect(failed).toBeInstanceOf(StorageUnavailableError);
    expect((failed as StorageUnavailableError).cause).toBe(cause);
  });

  it("rejects with StorageUnavailableError when new Worker() throws where there is no SharedWorker", async () => {
    const cause = insecure("The operation is insecure.");
    putGlobal(
      "Worker",
      class {
        constructor() {
          throw cause;
        }
      },
    );
    const folder = { getDirectoryHandle: async () => folder };
    putGlobal("navigator", { storage: { getDirectory: async () => folder } });

    const failed = await failure(openDb({ name: NAME }));

    expect(failed).toBeInstanceOf(StorageUnavailableError);
    expect((failed as StorageUnavailableError).cause).toBe(cause);
  });

  it("rejects with StorageUnavailableError when indexedDB.open() throws, as on a page of an opaque origin", async () => {
    const cause = insecure("The operation is insecure.");
    const real = indexedDB.open;
    indexedDB.open = () => {
      throw cause;
    };
    try {
      const failed = await failure(openHarnessDb({ name: NAME, forceMemory: true }));

      expect(failed).toBeInstanceOf(StorageUnavailableError);
      expect((failed as StorageUnavailableError).cause).toBe(cause);
    } finally {
      indexedDB.open = real;
    }
  });
});
