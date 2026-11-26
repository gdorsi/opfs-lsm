import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedError, destroyDb, openDb } from "../src/index.js";
import { attachEngineHostPort, EngineHost, findBrowserFs } from "../src/testing.js";

let n = 0;
let NAME = "";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);

type Node = FakeDir | Uint8Array;

/** An OPFS folder held in memory. */
class FakeDir {
  readonly children = new Map<string, Node>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, (child = new FakeDir()));
    if (!(child instanceof FakeDir)) throw new DOMException(name, "NotFoundError");
    return child;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.children.has(name) && opts?.create) this.children.set(name, new Uint8Array());
    if (!(this.children.get(name) instanceof Uint8Array)) throw new DOMException(name, "NotFoundError");
    return {
      getFile: async () => {
        const bytes = this.children.get(name);
        if (!(bytes instanceof Uint8Array)) throw new DOMException(name, "NotFoundError");
        return new File([bytes], name);
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (c: Uint8Array) => void chunks.push(c),
          close: async () => void this.children.set(name, new Uint8Array(await new Blob(chunks).arrayBuffer())),
          abort: async () => undefined,
        };
      },
    };
  }
  async removeEntry(name: string, opts?: { recursive?: boolean }) {
    const child = this.children.get(name);
    if (child === undefined) throw new DOMException(name, "NotFoundError");
    if (child instanceof FakeDir && child.children.size > 0 && !opts?.recursive) {
      throw new DOMException(name, "InvalidModificationError");
    }
    this.children.delete(name);
  }
  async *entries(): AsyncIterableIterator<[string, unknown]> {
    yield* this.children.entries();
  }
}

const ports: MessagePort[] = [];

/**
 * What a page has in a browser, so `openDb` itself runs: OPFS, and a
 * SharedWorker that serves the database as `host/shared-worker.ts` does. The
 * handle then owns its port to the worker, as it does in a tab.
 */
function installBrowser(): void {
  const root = new FakeDir();
  const host = new EngineHost((name) => findBrowserFs(name));
  vi.stubGlobal(
    "SharedWorker",
    class {
      readonly port: MessagePort;
      constructor() {
        const { port1, port2 } = new MessageChannel();
        attachEngineHostPort(port1, host);
        ports.push(port1, port2);
        this.port = port2;
      }
    },
  );
  vi.stubGlobal("Worker", class {});
  Object.defineProperty(navigator, "storage", { value: { getDirectory: async () => root }, configurable: true });
}

function deleteWal(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  NAME = `close-in-flight-${++n}`;
  await deleteWal();
  installBrowser();
});

afterEach(async () => {
  for (const port of ports.splice(0)) port.close();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "storage");
  await deleteWal();
});

/** How a call ended: "resolved", "ClosedError" (README, "Errors"), or the error it rejected with. */
function outcome(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => "resolved",
    (err: unknown) => (err instanceof ClosedError && err.code === "closed" ? "ClosedError" : err),
  );
}

describe("a call in flight on an openDb handle when the handle closes", () => {
  it("reads and writes through the SharedWorker port before it closes", async () => {
    const db = await openDb({ name: NAME, reserveBytes: 0 });
    await db.put(b("k"), b("v"));
    expect(dec.decode((await db.get(b("k")))!)).toBe("v");
    await db.dangerousDestroy();
    expect(await db.get(b("k"))).toBeUndefined();
    await db.close();
  });

  it("rejects a dangerousDestroy that close() overtakes with ClosedError", async () => {
    const db = await openDb({ name: NAME, reserveBytes: 0 });
    await db.put(b("k"), b("v"));
    const destroying = outcome(db.dangerousDestroy());
    await db.close();
    expect(await destroying).toBe("ClosedError");
  });

  it("ends a dangerousDestroy that races destroyDb done or with ClosedError", async () => {
    const db = await openDb({ name: NAME, reserveBytes: 0 });
    await db.put(b("k"), b("v"));
    const closed = new Promise<string>((resolve) => db.changes((e) => e.kind === "closed" && resolve(e.reason)));
    const destroying = outcome(db.dangerousDestroy());
    await destroyDb(NAME);
    expect(await closed).toBe("destroyed");
    expect(["resolved", "ClosedError"]).toContain(await destroying);
  });

  it("settles a dangerousDestroy whatever step of it close() or destroyDb lands on", async () => {
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    for (const end of ["close", "destroyDb"] as const) {
      for (let turns = 0; turns < 12; turns++) {
        NAME = `close-in-flight-${++n}`;
        const db = await openDb({ name: NAME, reserveBytes: 0 });
        await db.put(b("k"), b("v"));
        const destroying = outcome(db.dangerousDestroy());
        for (let i = 0; i < turns; i++) await turn();
        await (end === "close" ? db.close() : destroyDb(NAME));
        const hung = new Promise((resolve) => setTimeout(resolve, 2000, `never settled: ${end} after ${turns} turns`));
        expect(["resolved", "ClosedError"]).toContain(await Promise.race([destroying, hung]));
        await db.close();
        await deleteWal();
      }
    }
  }, 60_000);
});
