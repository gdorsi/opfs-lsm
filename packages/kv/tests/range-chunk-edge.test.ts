import { afterEach, expect, it } from "vitest";
import type { Db, Range } from "../src/index.js";
import { MemoryFs, openHarnessDb } from "../src/testing.js";

/**
 * A scan that ends at a key yields the key just before it, wherever the
 * memtable keeps the two: every pair of neighbours is asked, so the pair a
 * chunk boundary separates is among them whatever the chunk size is.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
const N = 3000;

const opened: Db[] = [];
let n = 0;

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

async function open(): Promise<Db> {
  const db = await openHarnessDb({ name: `range-chunk-edge-${process.pid}-${++n}`, fs: new MemoryFs(), maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

type Reads = Pick<Db, "range" | "count">;

async function keysOf(reads: Reads, range: Range): Promise<string[]> {
  const out: string[] = [];
  for await (const e of reads.range(range)) out.push(dec.decode(e.key));
  return out;
}

/** The pairs of neighbours of `live` that a scan from the first to the second, or one that ends at the second, reads wrong. */
async function wrongNeighbours(reads: Reads, live: readonly number[]): Promise<string[]> {
  const wrong: string[] = [];
  for (let j = 1; j < live.length; j++) {
    const prev = dec.decode(keyOf(live[j - 1]!));
    const pair = { start: keyOf(live[j - 1]!), endExclusive: keyOf(live[j]!) };
    const forward = await keysOf(reads, pair);
    const backward = await keysOf(reads, { endExclusive: pair.endExclusive, reverse: true, limit: 1 });
    const count = await reads.count(pair);
    if (forward.join() !== prev || backward.join() !== prev || count !== 1) {
      wrong.push(`[${prev}, ${dec.decode(pair.endExclusive)}): forward [${forward.join()}], last before the end [${backward.join()}], count ${count} (want 1)`);
    }
  }
  return wrong;
}

it("yields the key before an exclusive end for every pair of neighbours, keys written in order", async () => {
  const db = await open();
  await db.batch((tx) => {
    for (let i = 0; i < N; i++) tx.put(keyOf(i), enc.encode(`v${i}`));
  });
  const live = Array.from({ length: N }, (_, i) => i);
  expect(await wrongNeighbours(db, live)).toEqual([]);
  expect(await db.view((snap) => wrongNeighbours(snap, live))).toEqual([]);
});

it("yields the key before an exclusive end for every pair of neighbours, after range deletes cut the front of chunks", async () => {
  const db = await open();
  let seed = 7;
  const rnd = (k: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % k;
  const live = new Set<number>();
  // Several batches in random key order, so chunks split where the keys happened to fall.
  for (let b = 0; b < 6; b++) {
    await db.batch((tx) => {
      for (let i = 0; i < 700; i++) {
        const k = rnd(N);
        tx.put(keyOf(k), enc.encode(`v${b}`));
        live.add(k);
      }
    });
  }
  for (let d = 0; d < 40; d++) {
    const start = rnd(N);
    const end = start + 1 + rnd(40);
    await db.batch((tx) => tx.deleteRange({ start: keyOf(start), endExclusive: keyOf(end) }));
    for (let k = start; k < end; k++) live.delete(k);
  }
  const sorted = [...live].sort((a, b) => a - b);
  expect(sorted.length).toBeGreaterThan(1500);
  expect(await wrongNeighbours(db, sorted)).toEqual([]);
  expect(await db.view((snap) => wrongNeighbours(snap, sorted))).toEqual([]);
});
