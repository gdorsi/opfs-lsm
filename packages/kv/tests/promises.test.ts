import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedError, ConstraintError, openDb, type ChangeEvent, type Db } from "../src/index.js";
import { __resetMemoryFsForTests, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const NAME = "promises-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);
const s = (v: Uint8Array | undefined) => (v === undefined ? undefined : dec.decode(v));

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

let fs: MemoryFs;
const opened: Db[] = [];

async function open(writerId = "w1"): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, fs, writerId, maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

/** A handle that gets no BroadcastChannel message, so it learns of other writes only through `sync()`. */
async function openWithoutBus(writerId: string): Promise<Db> {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await open(writerId);
  } finally {
    g.BroadcastChannel = real;
  }
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  fs = new MemoryFs();
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  __resetMemoryFsForTests(NAME);
});

describe("openDb", () => {
  it("rejects a name outside /^[A-Za-z0-9_-]{1,64}$/ with ConstraintError", async () => {
    for (const name of ["my notes", "", "a".repeat(65), "a/b", "é", "a.b"]) {
      await expect(openDb({ name })).rejects.toBeInstanceOf(ConstraintError);
      await expect(openHarnessDb({ name, forceMemory: true })).rejects.toBeInstanceOf(ConstraintError);
    }
    const longest = "Az09_-".padEnd(64, "x");
    const db = await openHarnessDb({ name: longest, forceMemory: true });
    await db.close();
    __resetMemoryFsForTests(longest);
  });

  it("close() closes this handle only, and a new handle opens on the same rows", async () => {
    const a = await open("wa");
    const other = await open("wb");
    await a.put(b("k"), b("1"));
    await a.close();
    await expect(a.get(b("k"))).rejects.toBeInstanceOf(ClosedError);
    await other.sync();
    expect(s(await other.get(b("k")))).toBe("1");
    await other.put(b("k"), b("2"));
    const again = await open("wc");
    expect(s(await again.get(b("k")))).toBe("2");
  });
});

describe("get and getMany", () => {
  it("read the memtable and SST files without an IndexedDB transaction", async () => {
    const db = await open();
    await db.put(b("a"), b("1"));
    await ingest(db);
    await db.put(b("b"), b("2"));
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    try {
      expect(s(await db.get(b("a")))).toBe("1");
      expect(s(await db.get(b("b")))).toBe("2");
      expect(await db.get(b("x"))).toBeUndefined();
      expect((await db.getMany([b("a"), b("b"), b("x")])).map(s)).toEqual(["1", "2", undefined]);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });
});

describe("changes() on another handle", () => {
  it("reports a range delete with its `through` resolved below the record, over BroadcastChannel and through sync()", async () => {
    const writer = await open("wa");
    const onBus = await open("wb");
    const viaSync = await openWithoutBus("wc");
    const record = (db: Db) => {
      const events: ChangeEvent[] = [];
      db.changes((e) => events.push(e));
      return events;
    };
    const busEvents = record(onBus);
    const syncEvents = record(viaSync);

    await writer.put(b("k1"), b("1"));
    const second = await writer.batch((tx) => {
      tx.put(b("k2"), b("2"));
      tx.deleteRange({ start: b("k") }, { through: 1000 });
      tx.delete(b("k3"));
    });
    expect(syncEvents, "a handle with no bus hears nothing before sync()").toEqual([]);
    await viaSync.sync();
    expect(s(await viaSync.get(b("k1")))).toBeUndefined();
    expect(s(await viaSync.get(b("k2")))).toBe("2");
    const third = await writer.batch((tx) => tx.deleteRange({}));
    await vi.waitFor(() => expect(busEvents).toHaveLength(3));
    await viaSync.sync();

    const want = [
      { kind: "append", seq: 1, ops: [{ type: "put", key: b("k1"), value: b("1") }] },
      {
        kind: "append",
        seq: second,
        ops: [
          { type: "put", key: b("k2"), value: b("2") },
          { type: "deleteRange", start: b("k"), through: second - 1 },
          { type: "del", key: b("k3") },
        ],
      },
      { kind: "append", seq: third, ops: [{ type: "deleteRange", start: new Uint8Array(0), through: third - 1 }] },
    ];
    expect(busEvents).toEqual(want);
    expect(syncEvents).toEqual(want);
    expect(await onBus.count()).toBe(0);
  });
});
