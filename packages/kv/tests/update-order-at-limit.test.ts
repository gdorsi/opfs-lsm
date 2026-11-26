import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import type { ReadFs } from "../src/opfs/async-fs.js";
import { EngineHost, MemoryFs, createLocalIngestClient, openHarnessDb, type IngestClient } from "../src/testing.js";

const NAME = "update-order-at-limit";
const MiB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const filler = (i: number) => utf(`f${String(i).padStart(6, "0")}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settlesWithin = (p: Promise<unknown>, ms = 50) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

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

/** The tab's run reads take a few milliseconds, as a cold OPFS read does. */
const READ_MS = 20;
const slowReads = (fs: ReadFs): ReadFs => ({
  read: (path, offset, length) => sleep(READ_MS).then(() => fs.read(path, offset, length)),
  list: (dir) => fs.list(dir),
  open: async (path) => {
    const file = await fs.open(path);
    return file && { size: file.size, read: (offset, length) => sleep(READ_MS).then(() => file.read(offset, length)), close: () => file.close() };
  },
});

/** A handle that holds `key` at "0", with its memtable at the limit: `held` waits for a flush, which `release` lets through. */
async function fullHandle(key: Uint8Array) {
  await wipe();
  const fs = new MemoryFs();
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
  const db = await openHarnessDb({ name: NAME, fs, ingest: tabClient, memtableBytes: MiB, maxWalBytes: 1e12, wrapFs: slowReads });
  opened.push(db);
  await db.put(key, utf("0"));
  let held: Promise<number> | undefined;
  for (let i = 0; i < 500 && !held; i++) {
    const put = db.put(filler(i), new Uint8Array(16 * 1024).fill(i % 251));
    if (asked > 0 && !(await settlesWithin(put))) held = put;
    else await put;
  }
  expect(held, "a put waits at the memtable limit").toBeDefined();
  return { db, release, held: held! };
}

describe("writes of one handle called while a write waits at the memtable limit", () => {
  it("append in call order: a put, a delete and a batch take the seqs after the waiting write's", async () => {
    const key = utf("title");
    const { db, release, held } = await fullHandle(key);

    const calls = [db.put(key, utf("first")), db.delete(key), db.batch((tx) => tx.put(key, utf("last")))];
    release();
    const after = await held;

    expect(await Promise.all(calls)).toEqual([after + 1, after + 2, after + 3]);
    expect(text(await db.get(key))).toBe("last");
  });

  it("an update reads the put called before it, and loses nothing to the put called after it", async () => {
    const key = utf("count");
    // The flush moves the key into a run, so the update reads a page after its wait, and the later put appends first.
    const { db, release, held } = await fullHandle(key);

    const before = db.put(key, utf("before"));
    const read = db.update([key], ([value], tx) => {
      tx.put(key, utf(`${text(value)}+1`));
      return text(value);
    });
    expect(await settlesWithin(read), "the update at the limit waits").toBe(false);
    const later = db.put(key, utf("later"));
    release();
    await Promise.all([held, before, later]);

    // The update appends before the later put or after it. Its body read what the key held just before its own row.
    expect([
      { read: "before", stored: "later" },
      { read: "later", stored: "later+1" },
    ]).toContainEqual({ read: await read, stored: text(await db.get(key)) });
  });
});
