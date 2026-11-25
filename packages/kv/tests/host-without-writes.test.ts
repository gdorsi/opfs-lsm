import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageFullError, type ChangeEvent, type Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import { createLocalIngestClient, destroyHarnessDb, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { refuseWalAppends } from "./sim/byte-budget.js";

const MiB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);

let n = 0;
let name = "";
let fs: MemoryFs;
let readOnly: EngineHost;
let writing: EngineHost;
const opened: Db[] = [];

beforeEach(() => {
  name = `host-without-writes-${++n}`;
  fs = new MemoryFs();
  readOnly = new EngineHost(() => fs, { writes: false });
  writing = new EngineHost(() => fs);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of opened.splice(0)) await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

type Open = { memtableBytes?: number; reserveBytes?: number; bus?: false };

async function openOn(host: EngineHost, options: Open = {}): Promise<Db> {
  if (options.bus === false) vi.stubGlobal("BroadcastChannel", undefined);
  try {
    const db = await openHarnessDb({
      name,
      fs,
      ingest: createLocalIngestClient(host),
      memtableBytes: options.memtableBytes,
      reserveBytes: options.reserveBytes ?? 0,
    });
    opened.push(db);
    return db;
  } finally {
    vi.unstubAllGlobals();
  }
}

const withoutWrites = (options?: Open) => openOn(readOnly, options);
const withWrites = (options?: Open) => openOn(writing, options);

async function close(db: Db): Promise<void> {
  opened.splice(opened.indexOf(db), 1);
  await db.close();
}

async function read(db: Db, i: number): Promise<string | undefined> {
  const value = await db.get(key(i));
  return value && dec.decode(value);
}

async function count(db: Db): Promise<number> {
  let rows = 0;
  for await (const _ of db.range()) rows++;
  return rows;
}

function events(db: Db): ChangeEvent[] {
  const seen: ChangeEvent[] = [];
  db.changes((event) => seen.push(event));
  return seen;
}

function nextGap(db: Db): Promise<void> {
  return new Promise((resolve) => {
    const stop = db.changes((event) => {
      if (event.kind !== "gap") return;
      stop();
      resolve();
    });
  });
}

/** The seqs in the WAL database, as IndexedDB holds them. */
function walSeqs(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opfs-lsm-wal/${name}`);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const keys = req.result.transaction("wal").objectStore("wal").getAllKeys();
      keys.onsuccess = () => {
        req.result.close();
        resolve(keys.result as number[]);
      };
    };
  });
}

describe("a host that writes no run file", () => {
  it("keeps every row past memtableBytes in the WAL, and reads them all after a reopen", async () => {
    const db = await withoutWrites({ memtableBytes: MiB });
    const value = new Uint8Array(1000).fill(7);
    for (let i = 0; i < 3000; i += 500) {
      await db.batch((tx) => {
        for (let j = i; j < i + 500; j++) tx.put(key(j), value);
      });
    }
    await db.delete(key(3));
    await db.batch((tx) => tx.deleteRange({ start: key(10), endExclusive: key(20) }));
    await ingest(db);
    const rows = 3000 - 1 - 10;
    expect(await count(db)).toBe(rows);
    await close(db);

    const again = await withoutWrites({ memtableBytes: MiB });
    expect(await again.get(key(3))).toBeUndefined();
    expect(await again.get(key(15))).toBeUndefined();
    expect((await again.get(key(2999)))?.byteLength).toBe(1000);
    expect(await count(again)).toBe(rows);
    expect(fs.publishedPaths()).toEqual([]);
  }, 60_000);

  it("shows a write to another handle by the bus, and to one without a bus at its sync", async () => {
    const a = await withoutWrites();
    const b = await withoutWrites();
    const quiet = await withoutWrites({ bus: false });
    const arrived = new Promise<void>((resolve) => b.changes((event) => event.kind === "append" && resolve()));
    await a.put(key(1), enc.encode("one"));
    await arrived;
    expect(await read(b, 1)).toBe("one");
    expect(await read(quiet, 1)).toBeUndefined();
    await quiet.sync();
    expect(await read(quiet, 1)).toBe("one");
  });

  it("empties the database in every handle on dangerousDestroy, and takes writes after it", async () => {
    const a = await withoutWrites();
    const b = await withoutWrites();
    await a.put(key(1), enc.encode("one"));
    await b.put(key(2), enc.encode("two"));
    await a.sync();
    await b.sync();
    const seenA = events(a);
    const gapB = nextGap(b);

    await a.dangerousDestroy();

    expect(seenA.some((event) => event.kind === "gap")).toBe(true);
    expect(await count(a)).toBe(0);
    await gapB;
    expect(await count(b)).toBe(0);
    expect(await walSeqs()).toEqual([]);

    await a.put(key(3), enc.encode("three"));
    await b.sync();
    expect(await read(b, 3)).toBe("three");
    expect(await count(b)).toBe(1);
  });

  it("keeps what it took after destroyDb when a writing host opens the database later", async () => {
    const before = await withoutWrites();
    await before.put(key(1), enc.encode("removed"));
    await close(before);
    await destroyHarnessDb({ name, fs });

    const db = await withoutWrites();
    for (let i = 0; i < 5; i++) await db.put(key(i), enc.encode(`after ${i}`));
    await close(db);

    const host = await withWrites();
    await ingest(host);
    for (let i = 0; i < 5; i++) expect(await read(host, i)).toBe(`after ${i}`);
    expect(await count(host)).toBe(5);
  });

  it("opens when two handles open a new name at once", async () => {
    const [a, b] = await Promise.all([withoutWrites(), withoutWrites()]);
    await a.put(key(1), enc.encode("one"));
    await b.sync();
    expect(await read(b, 1)).toBe("one");
  });

  it("reads the run files a writing host left, and that host later flushes what it took", async () => {
    const first = await withWrites();
    for (let i = 0; i < 10; i++) await first.put(key(i), enc.encode(`host ${i}`));
    const { generation } = await ingest(first);
    expect(generation).toBeGreaterThan(0);
    await close(first);

    const db = await withoutWrites();
    for (let i = 0; i < 10; i++) expect(await read(db, i)).toBe(`host ${i}`);
    await db.put(key(10), enc.encode("no host writes"));
    await db.delete(key(0));
    expect((await ingest(db)).generation).toBe(generation);
    await close(db);

    const again = await withWrites();
    expect((await ingest(again)).generation).toBeGreaterThan(generation);
    expect(await read(again, 0)).toBeUndefined();
    expect(await read(again, 10)).toBe("no host writes");
    expect(await count(again)).toBe(10);
  });

  it("rejects a write the browser refuses with StorageFullError, calls no onStorageFull handler and writes no reserve", async () => {
    const reserveBytes = 64 * 1024;
    const origin = { free: Number.POSITIVE_INFINITY };
    const restore = refuseWalAppends(name, origin);
    try {
      const db = await withoutWrites({ reserveBytes });
      let calls = 0;
      db.onStorageFull(async () => void calls++);
      await db.put(key(0), enc.encode("zero"));
      await ingest(db);
      origin.free = 0;
      await expect(db.put(key(1), enc.encode("one"))).rejects.toBeInstanceOf(StorageFullError);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(0);
      expect(fs.publishedPaths()).toEqual([]);

      origin.free = Number.POSITIVE_INFINITY;
      await db.put(key(2), enc.encode("two"));
      expect(await read(db, 2)).toBe("two");
      await close(db);

      // The same steps on a writing host leave a reserve file, so the check above can see one.
      const hosted = await withWrites({ reserveBytes });
      await hosted.put(key(3), enc.encode("three"));
      await ingest(hosted);
      expect(fs.publishedPaths()).toContain(RESERVE_PATH);
    } finally {
      restore();
    }
  });
});
