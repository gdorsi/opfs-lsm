import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDbName, checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { TabWal, encodeOps, advanceIngested, listUningested } from "../src/idb/wal.js";

const NAME = "wal-read-test";
const IDB = `opfs-lsm-wal/${NAME}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode(`k${i}`)), value: checkValue(enc.encode(`v${i}`)) }];
}

function rawRow(seq: number, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("wal", "readwrite");
      tx.objectStore("wal").put(value, seq);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function deleteSeq(seq: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("wal", "readwrite");
      tx.objectStore("wal").delete(seq);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function seeded(count: number): Promise<TabWal> {
  const wal = await TabWal.open(checkDbName(NAME));
  for (let i = 1; i <= count; i++) await wal.append(encodeOps(put(i)));
  return wal;
}

function summary(records: readonly { seq: number; ops: readonly CheckedOp[] }[]): string[] {
  return records.map((r) => `${r.seq}:${r.ops.map((op) => dec.decode(op.key)).join(",")}`);
}

beforeEach(wipe);

describe("WAL read", () => {
  it("returns every record after since and after ingestedThrough", async () => {
    const wal = await seeded(12);
    await advanceIngested(wal, 4, 1);
    const tail = await wal.tail(2);
    expect(tail.head).toBe(12);
    expect(tail.ingestedThrough).toBe(4);
    expect(summary(tail.records)).toEqual(
      Array.from({ length: 8 }, (_, i) => `${i + 5}:k${i + 5}`),
    );
    expect(summary(await listUningested(wal, { maxBytes: 1 << 30 }))).toEqual(summary(tail.records));
    expect(summary((await wal.tail(10)).records)).toEqual(["11:k11", "12:k12"]);
    expect((await wal.tail(12)).records).toEqual([]);
    wal.close();
  });

  it("throws on a missing seq instead of shifting the ones after it", async () => {
    const wal = await seeded(5);
    await deleteSeq(3);
    await expect(wal.tail(0)).rejects.toThrow("wal gap in seqs 1..5");
    wal.close();
  });

  it("round-trips a batch of puts, an empty value and a delete as bytes", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff);
    await wal.append(encodeOps([
      { type: "put", key: checkKey(enc.encode("a")), value: checkValue(big) },
      { type: "put", key: checkKey(enc.encode("empty")), value: checkValue(new Uint8Array()) },
      { type: "del", key: checkKey(enc.encode("gone")) },
      { type: "put", key: checkKey(enc.encode("z")), value: checkValue(enc.encode("last")) },
    ]));
    const [record] = (await wal.tail(0)).records;
    const ops = record!.ops;
    expect(ops.map((op) => `${op.type}:${dec.decode(op.key)}`)).toEqual([
      "put:a",
      "put:empty",
      "del:gone",
      "put:z",
    ]);
    const value = (i: number) => (ops[i] as Extract<CheckedOp, { type: "put" }>).value;
    expect(value(0)).toEqual(big);
    expect(value(1).byteLength).toBe(0);
    expect(dec.decode(value(3))).toBe("last");
    wal.close();
  });

  it("rejects a row that is not bytes", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    await rawRow(1, [{ type: "put", key: new ArrayBuffer(1), value: new ArrayBuffer(1) }]);
    await expect(wal.tail(0)).rejects.toThrow("corrupt wal row: not bytes");
    wal.close();
  });

  it("rejects a truncated row", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    const row = new Uint8Array([0, 10, 0, 0, 0, 1, 2]);
    await rawRow(1, row.buffer);
    await expect(wal.tail(0)).rejects.toThrow("corrupt wal row: truncated");
    wal.close();
  });
});

/** A record whose one put is `bytes` op bytes long. */
function sized(bytes: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode("k")), value: checkValue(new Uint8Array(bytes - 1)) }];
}

const seqs = (records: readonly { seq: number }[]) => records.map((r) => r.seq);

describe("WAL read with a byte cap", () => {
  it("returns the oldest records that fit, up to the cap", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    for (let i = 0; i < 6; i++) await wal.append(encodeOps(sized(10)));
    expect(seqs(await listUningested(wal, { maxBytes: 35 }))).toEqual([1, 2, 3]);
    expect(seqs(await listUningested(wal, { maxBytes: 30 }))).toEqual([1, 2, 3]);
    expect(seqs(await listUningested(wal, { maxBytes: 29 }))).toEqual([1, 2]);
    await advanceIngested(wal, 3, 1);
    expect(seqs(await listUningested(wal, { maxBytes: 1000 }))).toEqual([4, 5, 6]);
    expect(summary(await listUningested(wal, { maxBytes: 1000 }))).toEqual(
      summary(await listUningested(wal, { maxBytes: 1 << 30 })),
    );
    wal.close();
  });

  it("returns a record over the cap alone and never joins it to its neighbors", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    for (const bytes of [5, 100, 5, 5]) await wal.append(encodeOps(sized(bytes)));
    expect(seqs(await listUningested(wal, { maxBytes: 20 }))).toEqual([1]);
    await advanceIngested(wal, 1, 1);
    expect(seqs(await listUningested(wal, { maxBytes: 20 }))).toEqual([2]);
    await advanceIngested(wal, 2, 2);
    expect(seqs(await listUningested(wal, { maxBytes: 20 }))).toEqual([3, 4]);
    expect(seqs(await listUningested(wal, { maxBytes: 1 }))).toEqual([3]);
    wal.close();
  });

  it("returns nothing when everything is ingested", async () => {
    const wal = await seeded(3);
    await advanceIngested(wal, 3, 1);
    expect(await listUningested(wal, { maxBytes: 10 })).toEqual([]);
    wal.close();
  });

  it("reads about a cap's worth of the log, not all of it", async () => {
    const wal = await TabWal.open(checkDbName(NAME));
    for (let i = 0; i < 300; i++) await wal.append(encodeOps(sized(10)));
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const records = await listUningested(wal, { maxBytes: 100 });
    const rowsRead = getAll.mock.results.reduce(
      (n, r) => n + (r.value as IDBRequest<unknown[]>).result.length,
      0,
    );
    getAll.mockRestore();
    expect(records).toHaveLength(10);
    expect(rowsRead).toBeLessThanOrEqual(12);
    wal.close();
  });

  it("still reports a gap in the log", async () => {
    const wal = await seeded(5);
    await deleteSeq(3);
    await expect(listUningested(wal, { maxBytes: 1000 })).rejects.toThrow("wal gap in seqs");
    wal.close();
  });
});
