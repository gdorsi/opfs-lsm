import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveWorker } from "../src/host/engine-host.js";
import type { Db } from "../src/index.js";
import { createPortIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();

let n = 0;
let name = "";
let fs: MemoryFs;
const ports: MessagePort[] = [];
const opened: Db[] = [];

beforeEach(() => {
  name = `worker-entry-${++n}`;
  fs = new MemoryFs();
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

/** Runs the entry as a SharedWorker's script, then connects a tab to it. */
function startShared(fileHandle: new () => object): MessagePort {
  vi.stubGlobal("FileSystemFileHandle", fileHandle);
  vi.stubGlobal("onconnect", null);
  serveWorker((writes) => new EngineHost(() => fs, { writes }));
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const scope = globalThis as unknown as { onconnect: (ev: { ports: MessagePort[] }) => void };
  scope.onconnect({ ports: [port2] });
  return port1;
}

/** Runs the entry as a dedicated Worker's script, whose global scope is the page's one port. */
function startDedicated(): MessagePort {
  vi.stubGlobal("FileSystemFileHandle", class { createWritable() {} });
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  vi.stubGlobal("addEventListener", port2.addEventListener.bind(port2));
  vi.stubGlobal("removeEventListener", port2.removeEventListener.bind(port2));
  vi.stubGlobal("postMessage", port2.postMessage.bind(port2));
  serveWorker((writes) => new EngineHost(() => fs, { writes }));
  // A dedicated worker's scope gets its page's messages without a start call.
  port2.start();
  return port1;
}

/** Writes a row through a tab on `port` and asks the host to flush it. */
async function writeAndFlush(port: MessagePort): Promise<void> {
  const db = await openHarnessDb({ name, fs, ingest: createPortIngestClient(port) });
  opened.push(db);
  await db.put(enc.encode("k"), enc.encode("v"));
  await ingest(db);
}

describe("the worker entry", () => {
  it("writes run files in a SharedWorker whose OPFS files have createWritable", async () => {
    await writeAndFlush(startShared(class { createWritable() {} }));
    expect(fs.publishedPaths().length).toBeGreaterThan(0);
  });

  it("writes no run file in a SharedWorker without createWritable, as in Safari 16 to 25", async () => {
    await writeAndFlush(startShared(class {}));
    expect(fs.publishedPaths()).toEqual([]);
  });

  it("serves its global scope in a dedicated Worker, and writes no run file there", async () => {
    await writeAndFlush(startDedicated());
    expect(fs.publishedPaths()).toEqual([]);
    const db = opened[0]!;
    expect(new TextDecoder().decode(await db.get(enc.encode("k")))).toBe("v");
    await db.dangerousDestroy();
    expect(await db.get(enc.encode("k"))).toBeUndefined();
  });
});
