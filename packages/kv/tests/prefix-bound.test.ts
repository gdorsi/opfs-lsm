import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prefixBound, type Db, type Entry } from "../src/index.js";
import { __resetMemoryFsForTests, ingest, openHarnessDb } from "../src/testing.js";

const NAME = "prefix-bound";
const enc = new TextEncoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

let db: Db;

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
});

afterEach(async () => {
  await db.close();
  __resetMemoryFsForTests(NAME);
});

// 61 and 62 are neighbours, and FF has no successor: the two cases an upper bound has to get right.
const ALPHABET = [0x00, 0x61, 0x62, 0xff];

/** Every key of up to three bytes of `ALPHABET`, the empty key included, in byte order. */
function universe(): Uint8Array[] {
  let level: number[][] = [[]];
  const all: number[][] = [[]];
  for (let length = 1; length <= 3; length++) {
    level = level.flatMap((key) => ALPHABET.map((byte) => [...key, byte]));
    all.push(...level);
  }
  return all.map((key) => Uint8Array.from(key)).sort(compare);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

const startsWith = (key: Uint8Array, prefix: Uint8Array) => prefix.every((byte, i) => key[i] === byte);
const hex = (key: Uint8Array) => Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function keys(scan: AsyncIterable<Entry>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of scan) out.push(hex(e.key));
  return out;
}

describe("prefixBound", () => {
  it("is the bounds the README shows for a text prefix", () => {
    expect(prefixBound(enc.encode("user/"))).toEqual({ start: enc.encode("user/"), endExclusive: enc.encode("user0") });
  });

  it.each(["in the memtable", "in a run"])(
    "holds exactly the keys that start with the prefix, whatever bytes the prefix ends with, %s",
    async (where) => {
      const all = universe();
      await db.batch((tx) => {
        for (const key of all) tx.put(key, key);
      });
      if (where === "in a run") await ingest(db);

      for (const prefix of all) {
        const want = all.filter((key) => startsWith(key, prefix)).map(hex);
        const bounds = prefixBound(prefix);
        expect(await keys(db.range(bounds)), `prefix ${hex(prefix)}`).toEqual(want);
        expect(await keys(db.range({ ...bounds, reverse: true })), `prefix ${hex(prefix)}, reverse`).toEqual([...want].reverse());
        expect(await db.count(bounds), `count of prefix ${hex(prefix)}`).toBe(want.length);
      }
    },
  );
});
