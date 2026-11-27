import { afterEach, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { MemoryFs, openHarnessDb } from "../src/testing.js";

/**
 * A scan and a view keep what they read while the memtable splits and
 * drops chunks around the rows they hold. A bounded scan is paused after
 * its first entries, inside a view. Then, several times and anywhere in the
 * key space, a dense run of new keys splits a chunk, a range delete empties
 * chunks, and rows are overwritten, those of the scan among them. Nothing
 * is flushed, so every row is a memtable row.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const N = 32000;
/** One key in `STEP` is there from the start, so a dense run of the others multiplies the rows of a span. */
const STEP = 4;
const KEYS = Array.from({ length: N }, (_, i) => enc.encode(`k${String(i).padStart(6, "0")}`));

const opened: Db[] = [];
let n = 0;

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

function rowsOf(vals: readonly (string | undefined)[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) if (vals[i] !== undefined) out.push(`${dec.decode(KEYS[i]!)}=${vals[i]}`);
  return out;
}

const row = (e: { key: Uint8Array; value: Uint8Array }) => `${dec.decode(e.key)}=${dec.decode(e.value)}`;

function firstDifference(got: readonly string[], want: readonly string[]): string | undefined {
  if (got.length === want.length && got.every((g, i) => g === want[i])) return undefined;
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  return `${got.length} entries, want ${want.length}; at ${i} got ${got[i]}, want ${want[i]}`;
}

/** What a scan or a view read that its snapshot does not hold, empty when every read agreed. */
async function run(seed: number): Promise<string[]> {
  let state = seed * 104729 + 3;
  const rnd = (k: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % k;
  const db = await openHarnessDb({ name: `view-chunk-ownership-${process.pid}-${++n}`, fs: new MemoryFs(), maxWalBytes: 1 << 30 });
  opened.push(db);
  const vals = new Array<string | undefined>(N).fill(undefined);
  let v = 0;
  const put = async (keys: readonly number[]) => {
    await db.batch((tx) => {
      for (const k of keys) {
        vals[k] = `v${++v}`;
        tx.put(KEYS[k]!, enc.encode(vals[k]!));
      }
    });
  };
  const deleteRange = async (from: number, to: number) => {
    await db.batch((tx) => tx.deleteRange({ start: KEYS[from]!, endExclusive: KEYS[to]! }));
    for (let k = from; k < to; k++) vals[k] = undefined;
  };
  await put(Array.from({ length: N / STEP }, (_, i) => i * STEP));

  const wrong: string[] = [];
  for (let round = 0; round < 60; round++) {
    const width = (300 + rnd(900)) * STEP;
    const from = rnd(N - width);
    const to = from + width;
    const reverse = rnd(2) === 1;
    await db.view(async (snap) => {
      const viewed = vals.slice();
      const scan = db.range({ start: KEYS[from]!, endExclusive: KEYS[to]!, reverse })[Symbol.asyncIterator]();
      const got: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await scan.next();
        if (!r.done) got.push(row(r.value));
      }
      const scanned = rowsOf(vals, from, to);
      if (reverse) scanned.reverse();

      const done: string[] = [];
      for (let op = 0, ops = 4 + rnd(4); op < ops; op++) {
        const what = rnd(4);
        if (what === 0) {
          // New keys between the ones a span holds: its chunk outgrows its size and splits.
          const at = rnd(N - 2000);
          await put(Array.from({ length: 2000 }, (_, i) => at + i).filter((k) => k % STEP !== 0));
          done.push(`split at ${at}`);
        } else if (what === 1) {
          const at = rnd(N - 5200);
          await deleteRange(at, at + 2400 + rnd(2800));
          done.push(`range delete at ${at}`);
        } else if (what === 2) {
          const at = rnd(N - 2400);
          await put(Array.from({ length: 80 }, () => at + rnd(600) * STEP));
          done.push(`writes at ${at}`);
        } else {
          // The rows the scan has not reached yet, and the rows next to them.
          await put(Array.from({ length: 80 }, () => (Math.floor(from / STEP) - 100 + rnd(width / STEP + 200)) * STEP).filter((k) => k >= 0 && k < N));
          done.push("writes in the scan");
        }
      }

      for (let r = await scan.next(); !r.done; r = await scan.next()) got.push(row(r.value));
      const label = `seed ${seed} round ${round}, scan of [${from}, ${to})${reverse ? " reverse" : ""} paused across ${done.join(", ")}`;
      const scanDiff = firstDifference(got, scanned);
      if (scanDiff) wrong.push(`${label}: paused scan read a later write: ${scanDiff}`);
      const all: string[] = [];
      for await (const e of snap.range()) all.push(row(e));
      const viewDiff = firstDifference(all, rowsOf(viewed, 0, N));
      if (viewDiff) wrong.push(`${label}: view read a later write: ${viewDiff}`);
    });
    const live: string[] = [];
    for await (const e of db.range()) live.push(row(e));
    const liveDiff = firstDifference(live, rowsOf(vals, 0, N));
    if (liveDiff) wrong.push(`seed ${seed} round ${round}: live scan: ${liveDiff}`);
    if (wrong.length > 3) break;
    // Keep several chunks: fill a span range deletes thinned out.
    if (rnd(4) === 0) {
      const fill = Math.floor(rnd(N - 4000) / STEP) * STEP;
      await put(Array.from({ length: 1000 }, (_, i) => fill + i * STEP));
    }
  }
  return wrong;
}

/** A database of `count` keys in order, each with the value "old", all in the memtable. */
async function filled(count: number): Promise<Db> {
  const db = await openHarnessDb({ name: `view-chunk-ownership-${process.pid}-${++n}`, fs: new MemoryFs(), maxWalBytes: 1 << 30 });
  opened.push(db);
  await db.batch((tx) => {
    for (let i = 0; i < count; i++) tx.put(KEYS[i * STEP]!, enc.encode("old"));
  });
  return db;
}

async function valuesOf(source: AsyncIterable<{ key: Uint8Array; value: Uint8Array }>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for await (const e of source) out[dec.decode(e.value)] = (out[dec.decode(e.value)] ?? 0) + 1;
  return out;
}

it("a view keeps every row when writes to the upper half, then a split far below them, then an overwrite of every key land during it", async () => {
  const count = 6000;
  const db = await filled(count);
  await db.view(async (snap) => {
    // The chunks of the upper half are now the table's own, and the ones below still the view's.
    await db.batch((tx) => {
      for (let i = count / 2; i < count; i++) tx.put(KEYS[i * STEP]!, enc.encode("mid"));
    });
    // Far more new keys than a chunk holds, next to one of the first keys: its chunk splits, more than once.
    await db.batch((tx) => {
      for (let i = 1; i <= 3000; i++) tx.put(enc.encode(`${dec.decode(KEYS[10 * STEP]!)}/${String(i).padStart(4, "0")}`), enc.encode("dense"));
    });
    await db.batch((tx) => {
      for (let i = 0; i < count; i++) tx.put(KEYS[i * STEP]!, enc.encode("new"));
    });
    expect(await valuesOf(snap.range())).toEqual({ old: count });
  });
  expect(await valuesOf(db.range())).toEqual({ new: count, dense: 3000 });
});

it("a view keeps every row when writes to a span, a range delete that empties it, then an overwrite of every key land during it", async () => {
  const count = 6000;
  const db = await filled(count);
  await db.view(async (snap) => {
    await db.batch((tx) => {
      for (let i = 2000; i < 4000; i++) tx.put(KEYS[i * STEP]!, enc.encode("new"));
    });
    await db.batch((tx) => tx.deleteRange({ start: KEYS[2000 * STEP]!, endExclusive: KEYS[4000 * STEP]! }));
    await db.batch((tx) => {
      for (let i = 0; i < count; i++) tx.put(KEYS[i * STEP]!, enc.encode("new"));
    });
    expect(await valuesOf(snap.range())).toEqual({ old: count });
  });
  expect(await valuesOf(db.range())).toEqual({ new: count });
});

for (const seed of Array.from({ length: Number(process.env.KV_CHUNKS_SEEDS ?? 2) }, (_, i) => i + 1)) {
  it(`a paused scan and a view keep their rows while chunks around them split or empty (seed ${seed})`, async () => {
    expect(await run(seed)).toEqual([]);
  }, 120_000);
}
