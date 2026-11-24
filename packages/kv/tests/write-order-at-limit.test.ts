import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  openHarnessDb,
  type IngestClient,
} from "../src/testing.js";

const NAME = "write-order-at-limit";
const MiB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const filler = (i: number) => enc.encode(`f${String(i).padStart(6, "0")}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settlesWithin = (p: Promise<unknown>, ms = 50) =>
  Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  await wipe();
});

describe("two puts of one key from one handle at the memtable limit", () => {
  it("keep call order: the put called last is the value stored", async () => {
    await wipe();
    const fs = new MemoryFs();
    // One host. The tab's own flush requests wait at a gate, the way a busy
    // SharedWorker answers them late; the host flushes meanwhile for another reason.
    const host = createLocalIngestClient(new EngineHost(() => fs));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    const tabClient: IngestClient = {
      ...host,
      watch: () => undefined,
      ingest: async (name, waitForCompaction) => {
        asked++;
        await gate;
        return host.ingest(name, waitForCompaction);
      },
    };
    const db = await openHarnessDb({ name: NAME, fs, ingest: tabClient, memtableBytes: MiB, maxWalBytes: 1e12 });
    opened.push(db);

    const key = enc.encode("title");
    // Fill the memtable to its limit: the tab asks for a flush, which waits at the gate.
    let held: Promise<number> | undefined;
    for (let i = 0; i < 500 && !held; i++) {
      const put = db.put(filler(i), new Uint8Array(16 * 1024).fill(i % 251));
      if (asked > 0 && !(await settlesWithin(put))) held = put;
      else await put;
    }
    expect(held, "a put waits at the memtable limit").toBeDefined();

    // The app writes "first" and does not await it: the memtable is full, so it waits for the flush.
    const first = db.put(key, enc.encode("first"));
    expect(await settlesWithin(first), "the put at the limit waits").toBe(false);

    // The host flushes the WAL (another tab asked, or its WAL limit tripped), and this tab installs it.
    await host.ingest(NAME, false);
    await db.sync();

    // Later, the app writes "second". The memtable has room now, and "first" still waits.
    const second = db.put(key, enc.encode("second"));

    release();
    await Promise.all([held, first, second]);

    expect(dec.decode((await db.get(key))!), "the value of the put called last").toBe("second");
    expect(await first, "the put called first takes the lower seq").toBeLessThan(await second);
  });
});

