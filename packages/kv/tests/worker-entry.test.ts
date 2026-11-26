import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDbName } from "../src/check.js";
import { serveWorker } from "../src/host/engine-host.js";
import type { Db } from "../src/index.js";
import { BrowserFs, findBrowserFs } from "../src/opfs/browser-fs.js";
import { createPortIngestClient, EngineHost, ingest, openHarnessDb } from "../src/testing.js";
import { fakeOpfs, type FakeDir, type FakeOrigin } from "./fake-opfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

let n = 0;
let name = "";
let root: FakeDir;
/** Lifted when the worker may reach OPFS. Its first call there is the probe's. */
let reachOpfs: Promise<void>;
const ports: MessagePort[] = [];
const opened: Db[] = [];

beforeEach(() => {
  name = `worker-entry-${++n}`;
  reachOpfs = Promise.resolve();
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  for (const port of ports.splice(0)) port.close();
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

/** The worker's globals in a browser whose file handles are `handles`. */
function browser(handles: FakeOrigin["handles"]): void {
  root = fakeOpfs(handles);
  const { locks } = navigator;
  vi.stubGlobal("navigator", {
    locks,
    storage: {
      getDirectory: async () => {
        await reachOpfs;
        return root;
      },
    },
  });
  vi.stubGlobal("FileSystemFileHandle", handles === "writable" ? class { createWritable() {} } : class {});
}

/** The call of the shipped entry. */
function serve(): void {
  serveWorker((writes) => new EngineHost((name) => findBrowserFs(name, writes), { writes: !!writes }));
}

/** Runs the entry as a SharedWorker's script, then connects a tab to it. */
function startShared(handles: FakeOrigin["handles"]): MessagePort {
  browser(handles);
  vi.stubGlobal("onconnect", null);
  serve();
  return connect();
}

function connect(): MessagePort {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const scope = globalThis as unknown as { onconnect: (ev: { ports: MessagePort[] }) => void };
  scope.onconnect({ ports: [port2] });
  return port1;
}

/** Runs the entry as a dedicated Worker's script, whose global scope is the page's one port. */
function startDedicated(): MessagePort {
  browser("writable");
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  vi.stubGlobal("addEventListener", port2.addEventListener.bind(port2));
  vi.stubGlobal("removeEventListener", port2.removeEventListener.bind(port2));
  vi.stubGlobal("postMessage", port2.postMessage.bind(port2));
  serve();
  // A dedicated worker's scope gets its page's messages without a start call.
  port2.start();
  return port1;
}

/** A tab on `port`. It reads the folder itself, as `openDb` does. */
async function open(port: MessagePort): Promise<Db> {
  const lsm = await root.getDirectoryHandle("opfs-lsm", { create: true });
  const dir = await lsm.getDirectoryHandle(name, { create: true });
  const fs = new BrowserFs(dir as unknown as FileSystemDirectoryHandle, checkDbName(name));
  const db = await openHarnessDb({ name, fs, ingest: createPortIngestClient(port) });
  opened.push(db);
  return db;
}

/** Writes a row through a tab on `port` and asks the host to flush it. */
async function writeAndFlush(port: MessagePort): Promise<Db> {
  const db = await open(port);
  await db.put(enc.encode("k"), enc.encode("v"));
  await ingest(db);
  return db;
}

const files = () => Object.keys(root.files());
const runs = () => files().filter((path) => path.endsWith(".sst"));
const scratch = () => files().filter((path) => !path.startsWith(`opfs-lsm/${name}/`));
const probes = () => root.origin.removals.filter((entry) => entry.startsWith("probe-"));

describe("the worker entry", () => {
  it("writes run files in a SharedWorker whose OPFS files have createWritable, and tries no file first", async () => {
    await writeAndFlush(startShared("writable"));
    expect(runs().length).toBeGreaterThan(0);
    expect(probes()).toEqual([]);
  });

  it("stages its run files in a SharedWorker with a sync access handle and no createWritable, as in Safari 18.6", async () => {
    const db = await writeAndFlush(startShared("sync"));
    expect(runs().length).toBeGreaterThan(0);
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    expect(probes().length).toBe(1);
    expect(scratch()).toEqual([]);
    expect(files().filter((path) => path.endsWith(".crswap"))).toEqual([]);
  });

  it.each([
    ["whose sync access handle is refused", "throws"],
    ["with no sync access handle", "none"],
  ] as const)("writes no run file in a SharedWorker without createWritable and %s", async (_what, handles) => {
    const db = await writeAndFlush(startShared(handles));
    expect(runs()).toEqual([]);
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    expect(scratch()).toEqual([]);
  });

  it("answers a request, and a tab that connects, while it finds out how to write", async () => {
    let lift!: () => void;
    reachOpfs = new Promise((resolve) => (lift = resolve));
    const first = await open(startShared("sync"));
    await first.put(enc.encode("k"), enc.encode("v"));
    const flushed = ingest(first);
    const second = await open(connect());
    const waiting = await Promise.race([flushed.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))]);
    expect(waiting).toBe("waiting");
    expect(probes()).toEqual([]);

    lift();
    expect((await flushed).generation).toBeGreaterThan(0);
    expect((await ingest(second)).generation).toBeGreaterThan(0);
    expect(runs().length).toBeGreaterThan(0);
  });

  it("serves its global scope in a dedicated Worker, and writes no run file there", async () => {
    const db = await writeAndFlush(startDedicated());
    expect(runs()).toEqual([]);
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.dangerousDestroy();
    expect(await db.get(enc.encode("k"))).toBeUndefined();
  });
});
