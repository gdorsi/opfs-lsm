import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs, __resetMemoryFsForTests, openDb, prefixBound } from "../src/index.js";

const NAME = "update";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const quiet = { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 };

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
afterEach(() => __resetMemoryFsForTests(NAME));

describe("update", () => {
  it("concurrent increments from two tabs lose none", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: NAME, writerId: "a", fs, forceMemory: true, ingestPolicy: quiet });
    const b = await openDb({ name: NAME, writerId: "b", fs, forceMemory: true, ingestPolicy: quiet });
    const bump = (db: typeof a) =>
      db.update([utf("n")], ([cur], tx) => {
        tx.put(utf("n"), utf(String(Number(text(cur) ?? "0") + 1)));
      });
    await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)));
    expect(text(await a.get(utf("n")))).toBe("20");
    await a.close();
    await b.close();
  });

  it("reads an ingested key in a tab that has not loaded the SST yet", async () => {
    const fs = new MemoryFs();
    const writer = await openDb({ name: NAME, writerId: "w", fs, forceMemory: true, ingestPolicy: quiet });
    await writer.put(utf("k"), utf("1"));
    await writer.ingest();
    const reader = await openDb({ name: NAME, writerId: "r", fs, forceMemory: true, ingestPolicy: quiet });
    const seen = await reader.update([utf("k"), utf("absent")], (values) =>
      values.map(text),
    );
    expect(seen).toEqual(["1", undefined]);
    await writer.close();
    await reader.close();
  });

  it("writes nothing when the body throws", async () => {
    const db = await openDb({ name: NAME, writerId: "w", fs: new MemoryFs(), forceMemory: true, ingestPolicy: quiet });
    await expect(
      db.update([utf("k")], (_values, tx) => {
        tx.put(utf("k"), utf("x"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.get(utf("k"))).toBeUndefined();
    await db.close();
  });
});

describe("rangeFollow", () => {
  it("follows each entry to its target across the log and an SST", async () => {
    const fs = new MemoryFs();
    const writer = await openDb({ name: NAME, writerId: "w", fs, forceMemory: true, ingestPolicy: quiet });
    await writer.batch((tx) => {
      tx.put(utf("doc/1"), utf("one"));
      tx.put(utf("idx/1"), utf("doc/1"));
    });
    await writer.ingest();
    await writer.batch((tx) => {
      tx.put(utf("doc/2"), utf("two"));
      tx.put(utf("idx/2"), utf("doc/2"));
      tx.put(utf("idx/3"), utf("doc/missing"));
    });
    const reader = await openDb({ name: NAME, writerId: "r", fs, forceMemory: true, ingestPolicy: quiet });
    const hits = await reader.rangeFollow(prefixBound(utf("idx/")), (e) => e.value);
    expect(hits.map((h) => [text(h.entry.key), text(h.value)])).toEqual([
      ["idx/1", "one"],
      ["idx/2", "two"],
      ["idx/3", undefined],
    ]);
    await writer.close();
    await reader.close();
  });
});
