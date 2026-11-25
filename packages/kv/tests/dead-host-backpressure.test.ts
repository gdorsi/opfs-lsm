/**
 * design.md, "Backpressure": "A host that cannot help does not stop writes."
 * A SharedWorker that never answers is such a host: its script did not load
 * (a CSP, a bundler that emitted no worker chunk), or the browser killed it.
 * `openDb` itself runs here, on an OPFS held in memory and a SharedWorker
 * whose port nothing reads. A known gap (docs/verification.md, "Gaps"): the
 * write at the limit waits for a flush that never ends, and a fix needs a
 * deadline on that wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/index.js";

let n = 0;
let NAME = "";
const enc = new TextEncoder();
const MiB = 1024 * 1024;

/** An OPFS folder held in memory: what a tab's open needs of one. */
class FakeDir {
  readonly children = new Map<string, FakeDir | Uint8Array>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, (child = new FakeDir()));
    if (!(child instanceof FakeDir)) throw new DOMException(name, "NotFoundError");
    return child;
  }
  async getFileHandle(name: string) {
    const bytes = this.children.get(name);
    if (!(bytes instanceof Uint8Array)) throw new DOMException(name, "NotFoundError");
    return { getFile: async () => new File([bytes], name) };
  }
  async *entries(): AsyncIterableIterator<[string, unknown]> {
    yield* this.children.entries();
  }
}

const ports: MessagePort[] = [];

function deleteWal(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  NAME = `dead-host-backpressure-${++n}`;
  await deleteWal();
  const root = new FakeDir();
  vi.stubGlobal(
    "SharedWorker",
    class {
      readonly port: MessagePort;
      constructor() {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1, port2);
        this.port = port2;
      }
    },
  );
  vi.stubGlobal("Worker", class {});
  Object.defineProperty(navigator, "storage", { value: { getDirectory: async () => root }, configurable: true });
});

afterEach(async () => {
  for (const port of ports.splice(0)) port.close();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "storage");
  await deleteWal();
});

const within = <T>(ms: number, work: Promise<T>): Promise<T | "pending"> =>
  Promise.race([work, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);

describe("a tab whose SharedWorker never answers", () => {
  it.fails("keeps writing past memtableBytes", async () => {
    const db = await within(1000, openDb({ name: NAME, memtableBytes: MiB }));
    // Returning passes the test, which `it.fails` reports: only the stalled puts below may fail it.
    if (db === "pending") return;

    // 40 puts of 64 KiB are 2.5 times the limit.
    const value = new Uint8Array(64 * 1024);
    let landed = 0;
    const writes = (async () => {
      for (let i = 0; i < 40; i++) {
        await db.put(enc.encode(`k${i}`), value);
        landed += 1;
      }
    })();
    await within(500, writes);

    expect(landed, "puts that resolved within 500 ms").toBe(40);
    await db.close();
  });
});
