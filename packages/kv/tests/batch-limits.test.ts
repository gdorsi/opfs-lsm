import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests, ingest } from "../src/testing.js";

const NAME = "batch-limits-test";
const enc = new TextEncoder();

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

const key = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);

describe("batch limits", () => {
  it("commits a batch of 20,000 ops and reads every key before and after a flush", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const count = 20_000;
    await db.batch((tx) => {
      for (let i = 0; i < count; i++) tx.put(key(i), enc.encode(String(i)));
    });
    const scan = async () => {
      let n = 0;
      for await (const _ of db.range()) n++;
      return n;
    };
    expect(await scan()).toBe(count);
    await ingest(db);
    expect(await scan()).toBe(count);
    expect(await db.get(key(count - 1))).toEqual(enc.encode(String(count - 1)));
    await db.close();
  });

  it("counts 256 bytes per op: 40,000 one-byte deletes are over the limit, 30,000 are not", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const deletes = (count: number) =>
      db.batch((tx) => {
        for (let i = 0; i < count; i++) tx.delete(new Uint8Array([i & 255]));
      });
    await db.put(new Uint8Array([7]), enc.encode("kept"));
    await expect(deletes(40_000)).rejects.toBeInstanceOf(ConstraintError);
    expect(await db.get(new Uint8Array([7]))).toEqual(enc.encode("kept"));
    await deletes(30_000);
    expect(await db.get(new Uint8Array([7]))).toBeUndefined();
    await db.close();
  });

  it("rejects a batch over 8 MiB of keys and values and writes none of it", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const value = new Uint8Array(1024 * 1024);
    await expect(
      db.batch((tx) => {
        for (let i = 0; i < 9; i++) tx.put(key(i), value);
      }),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(await db.get(key(0))).toBeUndefined();
    await db.close();
  });
});
