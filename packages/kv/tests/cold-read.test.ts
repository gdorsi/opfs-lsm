/**
 * A handle that just opened knows where every block of every run is from
 * the manifest, so its first reads wait for nothing but the blocks they
 * need. A run's tail holds its Bloom filter: a get starts that read and does
 * not wait for it, and a scan never asks for it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import type { ReadFs } from "../src/opfs/async-fs.js";
import { ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { sstBlockIndex } from "./oracle/sst-ref.js";
import { collect } from "./runs.js";

const NAME = "cold-read";
const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
const value = (i: number, round: number) => enc.encode(`${round}:${i}:`.padEnd(300, "v"));

/** Keys per flush: about 120 KiB, so every run has several blocks. */
const KEYS = 400;
/** Enough flushes to compact L0 once and leave runs above the result. */
const ROUNDS = 6;

function wipe(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

type Read = { readonly path: string; readonly tail: boolean };

/**
 * `inner`, with every read of a run file added to `reads`. A read that
 * starts past the run's blocks is of its tail, and with `holdTails` it never
 * returns.
 */
function recording(inner: ReadFs, reads: Read[], holdTails: boolean): ReadFs {
  return {
    read: (path, offset, length) => inner.read(path, offset, length),
    list: (dir) => inner.list(dir),
    async open(path) {
      const file = await inner.open(path);
      if (!file) return undefined;
      const index = sstBlockIndex((await inner.read(path, 0, Number.POSITIVE_INFINITY))!);
      const blocksEnd = index.blockStart[index.sepEnd.length]!;
      return {
        size: file.size,
        close: () => file.close(),
        read(offset, length) {
          const tail = offset >= blocksEnd;
          reads.push({ path, tail });
          return tail && holdTails ? new Promise<Uint8Array>(() => {}) : file.read(offset, length);
        },
      };
    },
  };
}

let fs: MemoryFs;
const dbs: Db[] = [];

/** Each round overwrites a third of the keys of the round before, so a key's newest version is in any level. */
const newestRound = (i: number) => {
  for (let round = ROUNDS - 1; round >= 0; round--) if (i >= round * 100 && i < round * 100 + KEYS) return round;
  return undefined;
};

beforeEach(async () => {
  await wipe();
  fs = new MemoryFs();
  const db = await openHarnessDb({ name: NAME, fs });
  for (let round = 0; round < ROUNDS; round++) {
    await db.batch((tx) => {
      for (let i = round * 100; i < round * 100 + KEYS; i++) tx.put(key(i), value(i, round));
    });
    await ingest(db);
  }
  await db.close();
});

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.close()));
  await wipe();
});

async function freshHandle(reads: Read[], holdTails: boolean): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, fs, wrapFs: (inner) => recording(inner, reads, holdTails) });
  dbs.push(db);
  return db;
}

describe("the first reads of a handle that just opened", () => {
  it("the database has runs in two levels, each of several blocks", async () => {
    for (const level of ["l0", "l1"]) {
      const runs = await fs.list(level);
      expect(runs.length, `level ${level}`).toBeGreaterThan(0);
      for (const name of runs) {
        const index = sstBlockIndex((await fs.read(`${level}/${name}`, 0, Number.POSITIVE_INFINITY))!);
        expect(index.sepEnd.length, `${level}/${name}`).toBeGreaterThan(1);
      }
    }
  });

  it("opening reads no byte of any run", async () => {
    const reads: Read[] = [];
    await freshHandle(reads, false);
    expect(reads).toEqual([]);
  });

  // 0 is in the oldest round only, 250 was overwritten twice, 899 is in the newest round only, and the others are in no run.
  it.each([0, 250, 899, 5, 900, 100_000].map((i) => [i]))("a get of key %i answers while every read of a run's tail is still out", async (i) => {
    const reads: Read[] = [];
    const db = await freshHandle(reads, true);
    const got = await db.get(i === 5 ? enc.encode("k00005x") : key(i));
    const round = i === 5 ? undefined : newestRound(i);
    expect(got && dec.decode(got)).toBe(round === undefined ? undefined : dec.decode(value(i, round)));
    // A key past every run asks no run. Any other get started the read of a Bloom filter, which is still out.
    expect(reads.some((r) => r.tail)).toBe(i < 900);
    expect(reads.some((r) => !r.tail)).toBe(i < 900);
  });

  it("a scan reads blocks and no run's tail", async () => {
    const reads: Read[] = [];
    const db = await freshHandle(reads, true);
    const got = await collect(db.range({ start: key(150), endExclusive: key(450) }));
    expect(got.map((e) => dec.decode(e.key))).toEqual(Array.from({ length: 300 }, (_, n) => dec.decode(key(150 + n))));
    expect(got.map((e) => dec.decode(e.value))).toEqual(Array.from({ length: 300 }, (_, n) => dec.decode(value(150 + n, newestRound(150 + n)!))));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((r) => r.tail)).toEqual([]);
  });

  it("once the Bloom filters loaded, a get of a key no run holds reads no block", async () => {
    const reads: Read[] = [];
    const db = await freshHandle(reads, false);
    const runs = (await Promise.all(["l0", "l1"].map(async (level) => (await fs.list(level)).map((name) => `${level}/${name}`)))).flat();
    // Between them these keys are inside every run's range, so the gets start the load of every filter.
    for (const absent of ["k00005x", "k00455x", "k00855x"]) expect(await db.get(enc.encode(absent))).toBeUndefined();
    expect(new Set(reads.filter((r) => r.tail).map((r) => r.path))).toEqual(new Set(runs));
    // The loads land a task or two after the gets that did not wait for them.
    for (let task = 0; task < 5; task++) await new Promise((resolve) => setTimeout(resolve));
    const before = reads.length;
    for (const absent of ["k00007x", "k00457x", "k00857x"]) expect(await db.get(enc.encode(absent))).toBeUndefined();
    expect(reads.length).toBe(before);
  });
});
