import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { ingest, openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(4, "0")}`);
/** Lengths on both sides of the pooled span, 65 bytes to 1 KiB, and enough of them to fill several pools. */
const LENGTHS = [0, 1, 64, 65, 100, 500, 1024, 1025, 3000];
const value = (i: number) => new Uint8Array(LENGTHS[i % LENGTHS.length]!).fill(i & 0xff);

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("values a read hands out", () => {
  it("are copies: changing one changes no other value and nothing stored, from the memtable and from runs", async () => {
    const n = 300;
    db = await openHarnessDb({ name: `copy-out-${process.pid}`, forceMemory: true });
    await db.batch((tx) => {
      for (let i = 0; i < n / 2; i++) tx.put(key(i), value(i));
    });
    await ingest(db);
    await db.batch((tx) => {
      for (let i = n / 2; i < n; i++) tx.put(key(i), value(i));
    });
    const keys = Array.from({ length: n }, (_, i) => key(i));
    const reads = [
      await db.getMany(keys),
      await Promise.all(keys.map((k) => db!.get(k))),
      (await Array.fromAsync(db.range())).map((e) => e.value),
    ];
    // Each value gets its own byte: two values that shared bytes would read the later one's.
    const mark = (r: number, i: number) => ((r * n + i) % 251) + 1;
    reads.forEach((values, r) => {
      expect(values.map((v) => v!.length)).toEqual(keys.map((_, i) => value(i).length));
      expect(values.filter((v) => v!.byteOffset % 8 !== 0)).toEqual([]);
      values.forEach((v, i) => v!.fill(mark(r, i)));
    });
    reads.forEach((values, r) => values.forEach((v, i) => expect(v!.every((b) => b === mark(r, i))).toBe(true)));
    expect(await db.getMany(keys)).toEqual(keys.map((_, i) => value(i)));
  });
});
