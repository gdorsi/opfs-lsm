import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageFullError, StorageUnavailableError, type ChangeEvent, type Db } from "../src/index.js";
import { destroyHarnessDb, ingest, MemoryFs, noHost, openHarnessDb } from "../src/testing.js";
import { refuseWalAppends } from "./sim/byte-budget.js";

const MiB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);

let n = 0;
let name = "";
let fs: MemoryFs;
const opened: Db[] = [];

beforeEach(() => {
  name = `no-host-${++n}`;
  fs = new MemoryFs();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of opened.splice(0)) await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

async function hostless(options: { memtableBytes?: number; bus?: false } = {}): Promise<Db> {
  if (options.bus === false) vi.stubGlobal("BroadcastChannel", undefined);
  try {
    const db = await openHarnessDb({ name, fs, ingest: noHost(fs), memtableBytes: options.memtableBytes });
    opened.push(db);
    return db;
  } finally {
    vi.unstubAllGlobals();
  }
}

async function hosted(): Promise<Db> {
  const db = await openHarnessDb({ name, fs });
  opened.push(db);
  return db;
}

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

describe("a handle with no host", () => {
  it("keeps writing past memtableBytes, and reads every row back after a reopen", async () => {
    const db = await hostless({ memtableBytes: MiB });
    const value = new Uint8Array(1000).fill(7);
    for (let i = 0; i < 3000; i += 500) {
      await db.batch((tx) => {
        for (let j = i; j < i + 500; j++) tx.put(key(j), value);
      });
    }
    await db.delete(key(3));
    await db.batch((tx) => tx.deleteRange({ start: key(10), endExclusive: key(20) }));
    const rows = 3000 - 1 - 10;
    expect(await db.get(key(3))).toBeUndefined();
    expect(await count(db)).toBe(rows);
    await close(db);

    const again = await hostless({ memtableBytes: MiB });
    expect(await again.get(key(3))).toBeUndefined();
    expect(await again.get(key(15))).toBeUndefined();
    expect((await again.get(key(2999)))?.byteLength).toBe(1000);
    expect(await count(again)).toBe(rows);
  }, 60_000);

  it("shows a write to another handle by the bus, and to one without a bus at its sync", async () => {
    const a = await hostless();
    const b = await hostless();
    const quiet = await hostless({ bus: false });
    const arrived = new Promise<void>((resolve) => b.changes((event) => event.kind === "append" && resolve()));
    await a.put(key(1), enc.encode("one"));
    await arrived;
    expect(await read(b, 1)).toBe("one");
    expect(await read(quiet, 1)).toBeUndefined();
    await quiet.sync();
    expect(await read(quiet, 1)).toBe("one");
  });

  it("empties the database in every handle on dangerousDestroy, and takes writes after it", async () => {
    const a = await hostless();
    const b = await hostless();
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

  it("keeps what it wrote after destroyDb when a host opens the database later", async () => {
    const before = await hostless();
    await before.put(key(1), enc.encode("removed"));
    await close(before);
    await destroyHarnessDb({ name, fs });

    const db = await hostless();
    for (let i = 0; i < 5; i++) await db.put(key(i), enc.encode(`after ${i}`));
    await close(db);

    const host = await hosted();
    await ingest(host);
    for (let i = 0; i < 5; i++) expect(await read(host, i)).toBe(`after ${i}`);
    expect(await count(host)).toBe(5);
  });

  it("opens when two handles open a new name at once", async () => {
    const both = await Promise.all([hostless(), hostless()]);
    await both[0]!.put(key(1), enc.encode("one"));
    await both[1]!.sync();
    expect(await read(both[1]!, 1)).toBe("one");
  });

  it("reads the files a host wrote, and a host flushes what it wrote", async () => {
    const first = await hosted();
    for (let i = 0; i < 10; i++) await first.put(key(i), enc.encode(`host ${i}`));
    const { generation } = await ingest(first);
    expect(generation).toBeGreaterThan(0);
    await close(first);

    const db = await hostless();
    for (let i = 0; i < 10; i++) expect(await read(db, i)).toBe(`host ${i}`);
    await db.put(key(10), enc.encode("hostless"));
    await db.delete(key(0));
    await close(db);

    const again = await hosted();
    expect((await ingest(again)).generation).toBeGreaterThan(generation);
    expect(await read(again, 0)).toBeUndefined();
    expect(await read(again, 10)).toBe("hostless");
    expect(await count(again)).toBe(10);
  });

  it("follows the generations of a host that runs beside it, which flushes its writes", async () => {
    const host = await hosted();
    const db = await hostless({ bus: false });
    await db.put(key(1), enc.encode("hostless"));
    await host.put(key(2), enc.encode("host"));
    const { generation } = await ingest(host);
    expect(generation).toBeGreaterThan(0);

    const gap = nextGap(db);
    await db.sync();
    await gap;
    expect(await read(db, 1)).toBe("hostless");
    expect(await read(db, 2)).toBe("host");

    await db.put(key(3), enc.encode("later"));
    expect((await ingest(host)).generation).toBeGreaterThan(generation);
    const fresh = await hostless();
    expect(await read(fresh, 3)).toBe("later");
    expect(await count(fresh)).toBe(3);
  });

  it("rejects with StorageUnavailableError when the files of the recorded generation are gone", async () => {
    const first = await hosted();
    await first.put(key(1), enc.encode("one"));
    await ingest(first);
    await close(first);
    for (const path of fs.publishedPaths()) await fs.remove(path);

    await expect(hostless()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("rejects a write the browser refuses with StorageFullError, and calls no onStorageFull handler", async () => {
    const origin = { free: Number.POSITIVE_INFINITY };
    const restore = refuseWalAppends(name, origin);
    try {
      const db = await hostless();
      let calls = 0;
      db.onStorageFull(async () => void calls++);
      origin.free = 0;
      await expect(db.put(key(1), enc.encode("one"))).rejects.toBeInstanceOf(StorageFullError);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(0);

      origin.free = Number.POSITIVE_INFINITY;
      await db.put(key(2), enc.encode("two"));
      expect(await read(db, 2)).toBe("two");
    } finally {
      restore();
    }
  });
});
