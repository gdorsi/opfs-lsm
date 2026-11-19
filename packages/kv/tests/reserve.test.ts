import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, StorageFull } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import {
  createLocalIngestClient,
  destroyHarnessDb,
  EngineHost,
  ingest,
  MemoryFs,
  openHarnessDb,
  readStats,
  settle,
} from "../src/testing.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { BudgetFs } from "./sim/byte-budget.js";

const MiB = 1024 * 1024;
const BUDGET = 12 * MiB;
const RESERVE = 4 * MiB;
const VALUE = 1000;
const BATCH = 256;
const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(8, "0")}`);

/** Bytes that do not compress, the same on every run. */
function noise(seed: number): Uint8Array {
  const words = new Uint32Array(VALUE / 4);
  let x = seed | 1;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x;
  }
  return new Uint8Array(words.buffer);
}

let name: string;
let fs: MemoryFs;
let budget: BudgetFs;
let host: EngineHost;
let dbCount = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `reserve-${++dbCount}`;
  fs = new MemoryFs();
  budget = new BudgetFs(fs, BUDGET);
  host = hostOf(budget);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  vi.restoreAllMocks();
});

/** A host on `folder` itself: a flush can outlive its test, and must not reach the next one's folder. */
function hostOf(folder: BudgetFs, overrides: ConstructorParameters<typeof EngineHost>[1] = {}): EngineHost {
  return new EngineHost(() => folder, overrides);
}

async function open(reserveBytes: number): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, reserveBytes });
  opened.push(db);
  return db;
}

/** Puts and flushes time-ordered batches until the browser refuses a write. Returns the rows put, flushed or not. */
async function fillToRefusal(db: Db): Promise<number> {
  let rows = 0;
  while (budget.refused === 0) {
    await putBatch(db, rows);
    rows += BATCH;
    await ingest(db).catch(() => undefined);
  }
  return rows;
}

/** One small write and a flush, so a compaction pass ends. */
async function flushOne(db: Db, i: number): Promise<void> {
  await db.put(keyOf(i), enc.encode("v"));
  await ingest(db);
}

async function putBatch(db: Db, from: number): Promise<void> {
  await db.batch((tx) => {
    for (let i = from; i < from + BATCH; i++) tx.put(keyOf(i), noise(i));
  });
}

async function runBytes(): Promise<number> {
  return ((await loadLatestGeneration(fs))?.runs ?? []).reduce((n, run) => n + run.bytes, 0);
}

async function readAll(db: Db): Promise<number[]> {
  await db.sync();
  const out: number[] = [];
  for await (const e of db.range()) out.push(Number(new TextDecoder().decode(e.key).slice(1)));
  return out;
}

const turns = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await turns(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("a full origin", () => {
  it("recovers a time-ordered database: the refused flush lands, one handler call frees half the rows, and the reserve returns", async () => {
    const db = await open(RESERVE);
    let rows = 0;
    let atFull = 0;
    const calls: StorageFull[] = [];
    db.onStorageFull(async (full) => {
      calls.push(full);
      atFull = await runBytes();
      await db.batch((tx) => tx.deleteRange({ start: keyOf(0), endExclusive: keyOf(rows / 2) }));
    });

    while (budget.refused === 0) {
      await putBatch(db, rows);
      rows += BATCH;
      // Every flush lands, the refused one too.
      await ingest(db);
      if (rows === BATCH) expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
    }

    await until(() => calls.length > 0 && budget.sizeOf(RESERVE_PATH) === RESERVE, "the reserve to return");
    await settle(db);
    await turns(100);
    expect(calls).toEqual([{ bytes: atFull, need: RESERVE }]);
    expect(await runBytes()).toBeLessThan(atFull * 0.6);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
    expect(await readAll(db)).toEqual(range(rows / 2, rows));
  }, 60_000);
  it("recovers a database of random keys", async () => {
    const db = await open(RESERVE);
    const half = enc.encode("k5");
    let calls = 0;
    db.onStorageFull(async () => {
      calls += 1;
      await db.batch((tx) => tx.deleteRange({ endExclusive: half }));
    });
    const model = new Set<number>();
    for (let from = 0; budget.refused === 0; from += BATCH) {
      // The digits of a row's key, reversed: the keys spread over the key space.
      await db.batch((tx) => {
        for (let i = from; i < from + BATCH; i++) {
          const key = Number(String(i).padStart(8, "0").split("").reverse().join(""));
          tx.put(keyOf(key), noise(i));
          model.add(key);
        }
      });
      await ingest(db);
    }

    await until(() => calls > 0 && budget.sizeOf(RESERVE_PATH) === RESERVE, "the reserve to return");
    expect(calls).toBe(1);
    expect(await readAll(db)).toEqual([...model].filter((key) => key >= 50_000_000).sort((a, b) => a - b));
  }, 60_000);

  it("asks a handler that frees nothing once per pass, never in a loop, and loses no row", async () => {
    const db = await open(RESERVE);
    let calls = 0;
    db.onStorageFull(async () => void calls++);
    const rows = await fillToRefusal(db);
    await until(() => calls > 0, "the offer");
    await turns(100);
    // A pass of the flush that was refused can end after the answer, and ask once more.
    const asked = calls;
    expect(asked).toBeLessThanOrEqual(2);

    await turns(500);
    expect(calls).toBe(asked);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
    expect(await readAll(db)).toEqual(range(0, rows));
  }, 60_000);

  it("makes no second offer, and writes no reserve, while a handler is still answering", async () => {
    const db = await open(RESERVE);
    let calls = 0;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    db.onStorageFull(async () => {
      calls += 1;
      await answered;
    });
    const rows = await fillToRefusal(db);
    await until(() => calls === 1, "the offer");
    // Space frees elsewhere, and passes end, while the offer is open.
    budget.limit += 2 * RESERVE;
    for (let i = 0; i < 3; i++) await flushOne(db, rows + i);
    expect(calls).toBe(1);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);

    answer();
    await until(() => budget.sizeOf(RESERVE_PATH) === RESERVE, "the reserve to return");
    expect(calls).toBe(1);
  }, 60_000);

  it("with no handler in any handle, warns once per handle and writes the reserve again once space is free", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await open(RESERVE);
    await open(RESERVE);
    const rows = await fillToRefusal(a);
    await until(() => warn.mock.calls.length === 2, "a warning from each handle");
    expect(String(warn.mock.calls[0]![0])).toMatch(`no tab has an onStorageFull handler to free ${RESERVE} bytes`);

    // The origin stays full: the next pass cannot write the reserve, and offers again.
    budget.limit = budget.used + 64 * 1024;
    await turns(100);
    await flushOne(a, rows);
    await turns(100);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);

    budget.limit += RESERVE;
    await flushOne(a, rows + 1);
    await until(() => budget.sizeOf(RESERVE_PATH) === RESERVE, "the reserve to return");
    expect(warn).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("offers once when the reserve never fits, and not at open", async () => {
    budget.limit = RESERVE / 2;
    const db = await open(RESERVE);
    const calls: StorageFull[] = [];
    db.onStorageFull(async (full) => void calls.push(full));
    await turns(100);
    expect(calls).toEqual([]);
    expect(budget.refused).toBe(0);

    await flushOne(db, 0);
    await until(() => calls.length === 1, "the offer");
    expect(calls).toEqual([{ bytes: await runBytes(), need: RESERVE }]);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
    await turns(300);
    expect(calls.length).toBe(1);
  });
});

describe("an offer", () => {
  /** An origin too small for the reserve: the first pass that ends offers. */
  async function openFull(): Promise<Db> {
    budget.limit = RESERVE / 2;
    return open(RESERVE);
  }

  it("is answered by one handle, once, when several have a handler", async () => {
    const a = await openFull();
    const b = await open(RESERVE);
    let calls = 0;
    a.onStorageFull(async () => void calls++);
    b.onStorageFull(async () => void calls++);
    await flushOne(a, 0);
    await until(() => calls > 0, "the offer");
    await turns(200);
    expect(calls).toBe(1);
  });

  it("is not answered on a lock grant that lands after the handler unsubscribed", async () => {
    const a = await openFull();
    const b = await open(RESERVE);
    let calls = 0;
    let strays = 0;
    a.onStorageFull(async () => void calls++);
    // A grant already on its way when the request aborts: the callback still runs.
    let granted: Promise<unknown> | undefined;
    vi.spyOn(navigator.locks, "request").mockImplementationOnce((...args: unknown[]) => {
      const run = args.at(-1) as (lock: Lock | null) => unknown;
      return (granted = Promise.resolve().then(() => run(null)));
    });
    b.onStorageFull(async () => void strays++)();
    await granted;
    b.onStorageFull(async () => void strays++);

    await flushOne(a, 0);
    await until(() => calls === 1, "the offer");
    await turns(100);
    expect(strays).toBe(0);
  });

  it("goes to another handle when the answering one closes mid-handler", async () => {
    const a = await openFull();
    const b = await open(RESERVE);
    let started!: () => void;
    const inHandler = new Promise<void>((resolve) => (started = resolve));
    a.onStorageFull(async () => {
      started();
      await new Promise(() => undefined);
    });
    await turns(50);
    let calls = 0;
    b.onStorageFull(async () => void calls++);
    await flushOne(b, 0);
    await inHandler;
    expect(calls).toBe(0);

    await a.close();
    opened.splice(opened.indexOf(a), 1);
    await until(() => calls === 1, "the offer to reach the other handle");
  });

  it("counts a handler that throws as an answer, and comes again only at a later pass", async () => {
    const error = vi.mocked(console.error);
    const db = await openFull();
    let calls = 0;
    db.onStorageFull(async () => {
      calls += 1;
      throw new Error("no luck");
    });
    await flushOne(db, 0);
    await until(() => calls === 1, "the offer");
    await turns(200);
    expect(calls).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/onStorageFull handler/), expect.any(Error));

    await flushOne(db, 1);
    await until(() => calls === 2, "a second offer after the next pass");
  });
});

describe("the reserve file", () => {
  const KiB = 1024;

  it("is not written by the open, and is written by the first pass that ends", async () => {
    const db = await open(64 * KiB);
    await turns(100);
    expect(fs.publishedPaths()).toEqual([]);
    await flushOne(db, 0);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
  });

  it("is written on a quiet database once it has been idle", async () => {
    host = hostOf(budget, { idleFlushMs: 20 });
    await open(64 * KiB);
    expect(fs.publishedPaths()).toEqual([]);
    await until(() => budget.sizeOf(RESERVE_PATH) === 64 * KiB, "the reserve");
    expect(fs.publishedPaths()).toEqual([RESERVE_PATH]);
  });

  it("has the largest size any open handle asks for, and the size of the next session after all closed", async () => {
    const a = await open(64 * KiB);
    await flushOne(a, 0);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
    const b = await open(128 * KiB);
    await flushOne(b, 1);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(128 * KiB);

    for (const db of opened.splice(0)) await db.close();
    expect(budget.sizeOf(RESERVE_PATH)).toBe(128 * KiB);
    await flushOne(await open(64 * KiB), 2);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
  });

  it("survives the sweeps, stays out of the stats layout, and goes with destroyDb", async () => {
    const db = await open(64 * KiB);
    for (let from = 0; from < 8 * BATCH; from += BATCH) {
      await putBatch(db, from);
      await ingest(db);
    }
    const stats = (await readStats(db)).host;
    expect(stats.compactionSteps).toBeGreaterThan(0);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
    expect(stats.layout.reduce((n, level) => n + level.bytes, 0)).toBe(await runBytes());

    await destroyHarnessDb({ name, fs: budget });
    opened.length = 0;
    expect(fs.publishedPaths()).toEqual([]);
    expect(budget.used).toBe(0);
  });

  it("is written again after destroyDb, although a tab that went away without closing still counts as open", async () => {
    host.watch(name, { maxWalBytes: 1 << 30, compactionMemoryBytes: 32 * MiB, reserveBytes: 64 * KiB });
    await flushOne(await open(64 * KiB), 0);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
    await destroyHarnessDb({ name, fs: budget });
    opened.length = 0;
    expect(fs.publishedPaths()).toEqual([]);

    await flushOne(await open(64 * KiB), 0);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * KiB);
  });
});

describe("reserveBytes 0", () => {
  it("keeps no file, removes the one an earlier session left, retries nothing and calls no handler", async () => {
    await flushOne(await open(64 * 1024), 0);
    for (const db of opened.splice(0)) await db.close();
    expect(budget.sizeOf(RESERVE_PATH)).toBe(64 * 1024);

    const db = await open(0);
    let calls = 0;
    db.onStorageFull(async () => void calls++);
    await flushOne(db, 1);
    expect(fs.publishedPaths()).not.toContain(RESERVE_PATH);

    let rows = BATCH;
    let failure: unknown;
    while (!failure) {
      await putBatch(db, rows);
      rows += BATCH;
      failure = await ingest(db).then(
        () => undefined,
        (err: unknown) => err,
      );
    }
    expect((failure as Error).name).toBe("QuotaExceededError");
    expect(budget.refused).toBe(1);
    await turns(200);
    expect(calls).toBe(0);
  }, 60_000);
});
