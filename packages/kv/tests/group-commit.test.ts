import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingest, MemoryFs, openHarnessDb, readStats, __resetMemoryFsForTests } from "../src/testing.js";
import { checkDbName, checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";

const NAME = "group-commit";
const IDB = `opfs-lsm-wal/${NAME}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const maxWalBytes = 1 << 30;

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(utf(`k${i}`)), value: checkValue(utf(`v${i}`)) }];
}

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** Move the head `by` seqs past the key generator, as a recovery that moves the head past the records does. */
async function raiseFloor(by: number): Promise<number> {
  const wal = await IdBWal.open(checkDbName(NAME));
  const meta = await wal.meta();
  expect(await wal.adopt(meta, meta.generation ?? 0, meta.ingestedThrough, meta.head + by, meta.generation ?? 0)).toBe(true);
  wal.close();
  return meta.head + by;
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetMemoryFsForTests(NAME);
});

describe("WAL group commit", () => {
  it("writes appends issued in one turn as one transaction, one seq each, in call order", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    const seqs = await Promise.all([1, 2, 3, 4, 5].map((i) => wal.append(put(i))));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(wal.groupSizes).toEqual([undefined, undefined, 1]);
    const tail = await wal.tail(0);
    expect(tail.records.map((r) => text(r.ops[0]!.key))).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    wal.close();
  });

  it("groups the appends that arrive while a group commits into the next one", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    const first = wal.append(put(1));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const rest = [2, 3, 4].map((i) => wal.append(put(i)));
    expect(await Promise.all([first, ...rest])).toEqual([1, 2, 3, 4]);
    // One group of 1, one of 3 (or 1 + 3 merged when the first was still active).
    const groups = wal.groupSizes.reduce((a, n) => a + (n ?? 0), 0);
    expect(groups).toBeLessThanOrEqual(2);
    wal.close();
  });

  it("rejects every caller of an aborted group and consumes no seq", async () => {
    const wal = await IdBWal.open(checkDbName(NAME));
    const proto = IDBDatabase.prototype;
    const real = proto.transaction;
    let armed = true;
    vi.spyOn(proto, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = real.apply(this, args as Parameters<typeof real>);
      if (armed && args[1] === "readwrite") {
        armed = false;
        queueMicrotask(() => tx.abort());
      }
      return tx;
    });
    const outcomes = await Promise.allSettled([1, 2, 3].map((i) => wal.append(put(i))));
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(await wal.append(put(4))).toBe(1);
    const tail = await wal.tail(0);
    expect(tail.records.map((r) => [r.seq, text(r.ops[0]!.key)])).toEqual([[1, "k4"]]);
    wal.close();
  });

  it("resolves every caller of a stale group with undefined, and keeps no record", async () => {
    await raiseFloor(10);
    const wal = await IdBWal.open(checkDbName(NAME));
    expect(await Promise.all([1, 2, 3].map((i) => wal.append(put(i))))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const tail = await wal.tail(0);
    expect(tail.head).toBe(10);
    expect(tail.records).toEqual([]);
    wal.close();
  });

  it("a stale group falls back to appendAfter: every write lands past the floor, in call order", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes });
    await db.put(utf("k0"), utf("v0"));
    await ingest(db);
    const floor = await raiseFloor(10);
    const seqs = await Promise.all([1, 2, 3].map((i) => db.put(utf(`k${i}`), utf(`v${i}`))));
    expect(seqs).toEqual([floor + 1, floor + 2, floor + 3]);
    for (const i of [0, 1, 2, 3]) expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    await db.close();
  });

  it("joins a group's records to the memtable and the change feed in seq order", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes });
    const seen: number[] = [];
    db.changes((event) => {
      if (event.kind === "append") seen.push(event.seq);
    });
    const seqs = await Promise.all(Array.from({ length: 8 }, (_, i) => db.put(utf(`k${i}`), utf(`v${i}`))));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seen).toEqual(seqs);
    expect((await readStats(db)).tab.walGroupSizes).toEqual([undefined, undefined, undefined, 1]);
    await db.close();
  });

  it("a put issued before close still commits", async () => {
    const fs = new MemoryFs();
    let db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes });
    const first = db.put(utf("a"), utf("1"));
    await new Promise((r) => setTimeout(r, 0));
    const second = db.put(utf("b"), utf("2"));
    const closed = db.close();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    await closed;
    db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes });
    expect(text(await db.get(utf("b")))).toBe("2");
    await db.close();
  });
});
