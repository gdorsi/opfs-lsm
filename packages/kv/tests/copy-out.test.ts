import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
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

  it("hands out keys as copies too, of any length, and keeps its own copy of a key it was given", async () => {
    // Keys on both sides of the pooled span, each with its own value.
    const lengths = [1, 63, 64, 65, 66, 100, 500, 1024, 1025, 3000];
    const longKey = (i: number) => {
      const k = new Uint8Array(lengths[i % lengths.length]! + 4).fill(0x61 + (i % 26));
      new DataView(k.buffer).setUint32(0, i);
      return k;
    };
    const n = 200;
    db = await openHarnessDb({ name: `copy-out-keys-${process.pid}`, forceMemory: true });
    const given = Array.from({ length: n }, (_, i) => longKey(i));
    const write = (from: number, to: number) =>
      db!.batch((tx) => {
        for (let i = from; i < to; i++) {
          tx.put(given[i]!, key(i));
          // The batch has its copy: the caller may reuse the buffer.
          given[i]!.fill(0xee);
        }
      });
    await write(0, n / 2);
    await ingest(db);
    await write(n / 2, n);
    const keys = Array.from({ length: n }, (_, i) => longKey(i));
    expect(await db.getMany(keys)).toEqual(keys.map((_, i) => key(i)));

    const scans = [await Array.fromAsync(db.range()), await db.view((snap) => snap.rangeValues({}, (v) => v.slice()))];
    for (const entries of scans) {
      expect(entries.map((e) => [...e.key])).toEqual(keys.map((k) => [...k]));
      for (const e of entries) e.key.fill(0xdd);
    }
    // Changing the keys a scan returned changed no other key of it and nothing stored.
    for (const entries of scans) expect(entries.every((e) => e.key.every((b) => b === 0xdd))).toBe(true);
    expect((await Array.fromAsync(db.range({ reverse: true }))).map((e) => [...e.key]).reverse()).toEqual(keys.map((k) => [...k]));
    expect(await db.getMany(keys)).toEqual(keys.map((_, i) => key(i)));
  });
});

describe("a scan whose earlier values the app transferred", () => {
  /** 100 bytes, so each copy of it comes from the shared pool. */
  const pooled = (s: string) => enc.encode(s.padEnd(100, "."));
  const names = Array.from({ length: 8 }, (_, i) => `m${i}`);

  it.each([
    { way: "forward", lone: "z", reverse: false },
    { way: "backward", lone: "a", reverse: true },
  ])("yields every key in order, $way", async ({ lone, reverse }) => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs, { l0StopRuns: Number.POSITIVE_INFINITY });
    db = await openHarnessDb({ name: `copy-out-transfer-${process.pid}-${lone}`, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
    // Two runs: `lone`, in the older, waits in the merge while every key of the newer passes it.
    await db.put(pooled(lone), pooled(lone));
    await ingest(db);
    await db.batch((tx) => {
      for (const name of names) tx.put(pooled(name), pooled(name));
    });
    await ingest(db);
    const want = [...names, lone].sort();
    if (reverse) want.reverse();

    // Several rounds, so the waiting key and a transferred value land in one pool buffer in at least one.
    for (let round = 0; round < 3; round++) {
      const seen: string[] = [];
      for await (const e of db.range({ reverse })) {
        seen.push(dec.decode(e.key).replace(/\.+$/, ""));
        const buffer = e.value.buffer as ArrayBuffer;
        if (buffer.byteLength > 0) structuredClone(buffer, { transfer: [buffer] });
      }
      expect(seen, `round ${round}`).toEqual(want);
    }
  });
});
