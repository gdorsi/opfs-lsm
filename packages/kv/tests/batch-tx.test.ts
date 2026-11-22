import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError, type BatchTx } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "batch-tx-test";
const b = (...bytes: number[]) => Uint8Array.from(bytes);

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

const open = () => openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });

describe("batch tx", () => {
  it("stores what a reused key and value buffer held at each put", async () => {
    const db = await open();
    const key = new Uint8Array(1);
    const value = new Uint8Array(1);
    await db.batch((tx) => {
      for (let i = 1; i <= 3; i++) {
        key[0] = i;
        value[0] = i * 10;
        tx.put(key, value);
      }
    });
    expect(await db.getMany([b(1), b(2), b(3)])).toEqual([b(10), b(20), b(30)]);
    await db.close();
  });

  it("stores what a reused Buffer value held at each put, at every size", async () => {
    const db = await open();
    const sizes = [10, 64, 65, 200, 1024, 1025, 3000];
    await db.batch((tx) => {
      for (const [i, n] of sizes.entries()) {
        const value = Buffer.alloc(n, i + 1);
        tx.put(b(i), value);
        value.fill(0xee);
      }
    });
    const got = await db.getMany(sizes.map((_, i) => b(i)));
    expect(got.map((v) => [v?.length, new Set(v)])).toEqual(sizes.map((n, i) => [n, new Set([i + 1])]));
    await db.close();
  });

  it("a read copy's buffer can be transferred without detaching stored values", async () => {
    const db = await open();
    await db.put(b(1), new Uint8Array(100).fill(1));
    const got = (await db.get(b(1)))!;
    await db.put(b(2), new Uint8Array(100).fill(2));
    structuredClone(got, { transfer: [got.buffer as ArrayBuffer] });
    expect((await db.getMany([b(1), b(2)])).map((v) => v?.length)).toEqual([100, 100]);
    await db.close();
  });

  it("an update stores what a reused buffer held at each put", async () => {
    const db = await open();
    const key = new Uint8Array(1);
    await db.update([b(1)], (_values, tx) => {
      key[0] = 1;
      tx.put(key, b(1));
      key[0] = 2;
      tx.put(key, b(2));
    });
    expect(await db.getMany([b(1), b(2)])).toEqual([b(1), b(2)]);
    await db.close();
  });

  it("deleteRange keeps the bounds it was given when the caller reuses them", async () => {
    const db = await open();
    await db.batch((tx) => {
      for (let i = 1; i <= 4; i++) tx.put(b(i), b(i));
    });
    const start = b(2);
    const end = b(3);
    await db.batch((tx) => {
      tx.deleteRange({ start, endExclusive: end });
      start[0] = 0;
      end[0] = 9;
    });
    expect(await db.getMany([b(1), b(2), b(3), b(4)])).toEqual([b(1), undefined, b(3), b(4)]);
    await db.close();
  });

  it("a tx used after its callback returned throws and writes nothing", async () => {
    const db = await open();
    let saved!: BatchTx;
    await db.batch((tx) => {
      saved = tx;
      tx.put(b(1), b(1));
    });
    expect(() => saved.put(b(2), b(2))).toThrow(ConstraintError);
    expect(() => saved.delete(b(1))).toThrow(ConstraintError);
    expect(() => saved.deleteRange({})).toThrow(ConstraintError);
    await db.sync();
    expect(await db.getMany([b(1), b(2)])).toEqual([b(1), undefined]);
    await db.close();
  });

  it("a build that catches a refused op still rejects the whole batch", async () => {
    const db = await open();
    const refused = db.batch((tx) => {
      tx.put(b(1), b(1));
      try {
        tx.put(new Uint8Array(8193), b(2));
      } catch {}
      tx.put(b(3), b(3));
    });
    await expect(refused).rejects.toThrow(ConstraintError);
    expect(await db.getMany([b(1), b(3)])).toEqual([undefined, undefined]);
    await db.close();
  });

  it("a callback that returns a thenable rejects with ConstraintError and writes nothing", async () => {
    const db = await open();
    const build = async (tx: BatchTx) => {
      tx.put(b(1), b(1));
    };
    await expect(db.batch(build as unknown as (tx: BatchTx) => void)).rejects.toThrow(ConstraintError);
    expect(await db.get(b(1))).toBeUndefined();
    await db.close();
  });
});
