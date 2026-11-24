import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { openDbWith } from "../src/harness.js";
import { attachEngineHostPort, EngineHost, MemoryFs } from "../src/testing.js";
import { BudgetFs, refuseWalAppends } from "./sim/byte-budget.js";

/**
 * `openDb` gives each handle a port client of its own (`workerIngest`), and
 * the handle's `close()` closes that client. Here a stand-in SharedWorker
 * hands out a MessagePort to an in-process host, so the handle owns its
 * client exactly as in a browser.
 */
const NAME = "close-then-refused";
const utf = (s: string) => new TextEncoder().encode(s);
const savedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) undo();
  vi.restoreAllMocks();
  if (savedWorker === undefined) Reflect.deleteProperty(globalThis, "SharedWorker");
  else (globalThis as { SharedWorker?: unknown }).SharedWorker = savedWorker;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

function installWorker(host: EngineHost): void {
  Object.defineProperty(globalThis, "SharedWorker", {
    configurable: true,
    writable: true,
    value: class {
      readonly port: MessagePort;
      constructor() {
        const { port1, port2 } = new MessageChannel();
        attachEngineHostPort(port1, host);
        cleanups.push(() => port1.close());
        this.port = port2;
      }
    },
  });
}

const TIMEOUT = Symbol("still pending");
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);

describe("a handle that owns its port client", () => {
  it("settles a put whose append the browser refuses after close() began", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fs = new MemoryFs();
    const budget = new BudgetFs(fs, 1 << 20);
    installWorker(new EngineHost(() => budget));
    const db: Db = await openDbWith({ name: NAME, fs, reserveBytes: 0 });
    await db.put(utf("first"), utf("row"));

    cleanups.push(refuseWalAppends(NAME, budget));
    budget.limit = budget.used; // the origin is full
    // Close the handle as soon as the append is in flight in IndexedDB.
    const add = IDBObjectStore.prototype.add;
    let closing: Promise<void> | undefined;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
      const req = add.apply(this, args);
      if (this.name === "wal") closing ??= db.close();
      return req;
    };
    cleanups.push(() => (IDBObjectStore.prototype.add = add));

    const put = db.put(utf("k"), utf("v")).then(
      () => "resolved",
      (e: unknown) => e,
    );
    const outcome = await within(put, 1000);
    await closing;
    // A refused append after close must settle: StorageFullError or ClosedError, not hang.
    expect(outcome).not.toBe(TIMEOUT);
  });
});
