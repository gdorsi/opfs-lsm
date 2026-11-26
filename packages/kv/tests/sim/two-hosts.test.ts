import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, readStats, settle } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";

const SEEDS = Number(process.env.KV_TWOHOSTS_SEEDS ?? 12);
const FIRST = Number(process.env.KV_TWOHOSTS_FIRST ?? (process.env.KV_TWOHOSTS_SEEDS ? 1 + Math.floor(Math.random() * 2 ** 30) : 1));
const ROUNDS = 48;
const KEYS = 300;
const HANG_MS = 20_000;
/** Small runs and a stop below the four runs a merge starts at, so a flush takes several runs and waits on a full L0 for a pass of either host. */
const HOST = { flushRunBytes: 4 * 1024, l0StopRuns: 2 };

const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => `k${String(i).padStart(3, "0")}`;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { readonly type: "put"; readonly key: string; readonly value: string }
  | { readonly type: "del"; readonly key: string }
  | { readonly type: "range"; readonly start: string; readonly end: string };

type Batch = { readonly ops: readonly Op[]; seq: number };

/** A range delete removes the rows written before its batch, so it goes first. */
function apply(model: Map<string, string>, ops: readonly Op[]): void {
  for (const op of ops) {
    if (op.type === "range") for (const k of [...model.keys()]) if (k >= op.start && k < op.end) model.delete(k);
  }
  for (const op of ops) {
    if (op.type === "put") model.set(op.key, op.value);
    else if (op.type === "del") model.delete(op.key);
  }
}

async function rowsOf(db: Db): Promise<[string, string][]> {
  await db.sync();
  const rows: [string, string][] = [];
  for await (const e of db.range()) rows.push([dec.decode(e.key), dec.decode(e.value)]);
  return rows;
}

const sorted = (model: Map<string, string>) => [...model].sort(([a], [b]) => (a < b ? -1 : 1));

/** What the hosts did over the runs, so the test can say they met it. */
const tally = { flushes: 0, stops: 0, steps: 0 };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function run(seed: number): Promise<void> {
  const random = rng(seed);
  const below = (n: number) => Math.floor(random() * n);
  const name = `two-hosts-${seed}`;
  const fs = new MemoryFs();
  const open = () =>
    openHarnessDb({ name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs, HOST)), maxWalBytes: 24 * 1024 });
  const dbs = [await open(), await open()];
  const model = new Map<string, string>();
  let head = 0;
  let stamp = 0;

  const batch = (db: Db): Promise<Batch> => {
    const ops: Op[] = [];
    for (let i = 1 + below(12); i > 0; i--) {
      const roll = random();
      if (roll < 0.75) ops.push({ type: "put", key: key(below(KEYS)), value: `${++stamp}:${"x".repeat(below(300))}` });
      else if (roll < 0.95) ops.push({ type: "del", key: key(below(KEYS)) });
      else {
        const from = below(KEYS);
        ops.push({ type: "range", start: key(from), end: key(from + 1 + below(20)) });
      }
    }
    return db
      .batch((tx) => {
        for (const op of ops) {
          if (op.type === "put") tx.put(enc.encode(op.key), enc.encode(op.value));
          else if (op.type === "del") tx.delete(enc.encode(op.key));
          else tx.deleteRange({ start: enc.encode(op.start), endExclusive: enc.encode(op.end) });
        }
      })
      .then((seq) => ({ ops, seq }));
  };

  /** Every call of a round settles, or the seed fails here and not at the test's timeout. */
  const settled = async <T>(what: string, calls: readonly Promise<T>[]): Promise<T[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => (timer = setTimeout(resolve, HANG_MS, "hung")));
    const out = await Promise.race([Promise.all(calls), hung]);
    clearTimeout(timer);
    if (out === "hung") throw new Error(`seed ${seed}, ${what}: a call did not settle in ${HANG_MS} ms`);
    return out;
  };

  const destroyAt = 8 + below(ROUNDS - 16);
  for (let round = 0; round < ROUNDS; round++) {
    const what = `round ${round}`;
    const writes: Promise<Batch>[] = [];
    const flushes: Promise<unknown>[] = [];
    for (const db of dbs) {
      for (let i = 1 + below(3); i > 0; i--) writes.push(batch(db));
      if (random() < 0.35) flushes.push(ingest(db));
    }
    const acked = (await settled(what, writes)).sort((a, b) => a.seq - b.seq);
    for (const { ops, seq } of acked) {
      expect(seq, `seed ${seed}, ${what}: each write takes a seq of its own, past the ones before`).toBeGreaterThan(head);
      head = seq;
      apply(model, ops);
    }

    if (round === destroyAt) {
      // Both hosts flush and compact while one of them empties the database.
      flushes.push(...dbs.map((db) => ingest(db)));
      await settled(`${what}, the destroy`, [dbs[below(2)]!.dangerousDestroy()]);
      model.clear();
    }
    await settled(`${what}, the flushes`, flushes);

    if (random() < 0.12) {
      const i = below(2);
      await dbs[i]!.close();
      dbs[i] = await open();
    }
    if (round % 6 === 5 || round === destroyAt) {
      for (const [i, db] of dbs.entries()) expect(await rowsOf(db), `seed ${seed}, ${what}: handle ${i}`).toEqual(sorted(model));
    }
  }

  await settled("the last flushes", dbs.map((db) => settle(db)));
  for (const [i, db] of dbs.entries()) expect(await rowsOf(db), `seed ${seed}: handle ${i} at the end`).toEqual(sorted(model));
  await settled("the last sweep", dbs.map((db) => ingest(db)));
  for (const db of dbs) {
    const { host } = await readStats(db);
    tally.flushes += host.flushes;
    tally.stops += host.l0Stops;
    tally.steps += host.compactionSteps;
  }
  const report = await checkDatabase(fs, name);
  expect(report.problems, `seed ${seed}: checkDatabase`).toEqual([]);
  expect(report.orphans, `seed ${seed}: run files no manifest lists`).toEqual([]);
  expect(
    report.state.map((e) => [dec.decode(e.key), dec.decode(e.value)]),
    `seed ${seed}: the files and the WAL`,
  ).toEqual(sorted(model));
  for (const db of dbs) await db.close();

  const fresh = await open();
  expect(await rowsOf(fresh), `seed ${seed}: a reopen on a fresh host`).toEqual(sorted(model));
  await fresh.close();
}

// Cross-host exclusion is the Web Lock, which Node has from 24.
describe.skipIf(!navigator.locks)("two writing hosts on one database", () => {
  it(`keep every acked write, through a destroy and host changes: seeds ${FIRST} to ${FIRST + SEEDS - 1}`, async () => {
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) await run(seed);
    expect(tally.flushes, "the runs met flushes").toBeGreaterThan(0);
    expect(tally.stops, "the runs met a flush that waited on a full L0").toBeGreaterThan(0);
    expect(tally.steps, "the runs met compactions").toBeGreaterThan(0);
  }, 30_000 + SEEDS * 20_000);
});
