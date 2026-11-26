import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, readStats, settle } from "../src/testing.js";
import { BudgetFs } from "./sim/byte-budget.js";
import { walMeta } from "./sim/check-database.js";

const KiB = 1024;
const RESERVE = 256 * KiB;
const enc = new TextEncoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);

let n = 0;
let name = "";
let fs: MemoryFs;
const opened: Db[] = [];

beforeEach(() => {
  name = `two-hosts-${++n}`;
  fs = new MemoryFs();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  vi.restoreAllMocks();
});

/** A handle on a host of its own, which writes to `folder`. */
async function open(folder: AsyncFs, options: { reserveBytes?: number; l0StopRuns?: number } = {}): Promise<Db> {
  const host = new EngineHost(() => folder, options.l0StopRuns === undefined ? {} : { l0StopRuns: options.l0StopRuns });
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, reserveBytes: options.reserveBytes ?? 0 });
  opened.push(db);
  return db;
}

async function keysOf(db: Db): Promise<string[]> {
  await db.sync();
  const keys: string[] = [];
  for await (const e of db.range()) keys.push(new TextDecoder().decode(e.key));
  return keys;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => new TextDecoder().decode(key(from + i)));

async function putRows(db: Db, from: number, to: number): Promise<void> {
  await db.batch((tx) => {
    for (let i = from; i < to; i++) tx.put(key(i), new Uint8Array(KiB).fill(i));
  });
}

describe("a flush stopped on a full L0", () => {
  it("resumes after the pass of another host that compacts", async () => {
    let lift!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (lift = resolve));
    const merging = new Promise<void>((resolve) => (reached = resolve));
    /** The folder of the host that compacts: its merge waits at its first output. */
    const slow: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: async (path) => {
        if (path.startsWith("l1/")) {
          reached();
          await gate;
        }
        return fs.create(path);
      },
    };
    const stopping = await open(fs, { l0StopRuns: 4 });
    const compacting = await open(slow);

    let fourth: Promise<unknown> | undefined;
    for (let run = 0; run < 4; run++) {
      await putRows(compacting, run * 10, run * 10 + 10);
      fourth = ingest(compacting);
      if (run < 3) await fourth;
    }
    await merging;

    await putRows(stopping, 40, 50);
    const resumed = ingest(stopping);
    const state = await Promise.race([resumed.then(() => "flushed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 100))]);
    expect(state).toBe("waiting");

    lift();
    await fourth;
    await resumed;
    const { head, ingestedThrough } = await walMeta(name);
    expect(ingestedThrough).toBe(head);
    expect((await readStats(stopping)).host).toMatchObject({ l0Stops: 1, compactionSteps: 0 });
    expect((await readStats(compacting)).host.compactionSteps).toBe(1);
    expect(await keysOf(stopping)).toEqual(range(0, 50));
  });
});

describe("two writing hosts on a full origin", () => {
  /**
   * Two handles with a reserve, each on its own host, both settled over the
   * reserve file, then a limit that the next flush does not fit under. Both
   * hosts flush at once, as they do when they hear the same rows.
   */
  async function refuseBoth(budget: BudgetFs): Promise<[Db, Db]> {
    const a = await open(budget, { reserveBytes: RESERVE });
    const b = await open(budget, { reserveBytes: RESERVE });
    await putRows(a, 0, 8);
    await settle(a);
    await settle(b);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
    budget.limit = budget.used + 16 * KiB;
    await putRows(a, 8, 72);
    await putRows(b, 72, 136);
    return [a, b];
  }

  const flushBoth = (dbs: readonly Db[]) => Promise.all(dbs.map((db) => ingest(db).catch(() => undefined)));

  it("lose no acked write, and the reserve is written again", async () => {
    const budget = new BudgetFs(fs, 1 << 30);
    const dbs = await refuseBoth(budget);
    for (const db of dbs) db.onStorageFull(async () => void (budget.limit += 2 * RESERVE));
    await flushBoth(dbs);
    expect(budget.refused).toBeGreaterThan(0);
    await vi.waitFor(() => expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE), { timeout: 10_000 });

    for (const db of dbs) expect(await keysOf(db)).toEqual(range(0, 136));
    await Promise.all(opened.splice(0).map((db) => db.close()));
    expect(await keysOf(await open(budget))).toEqual(range(0, 136));
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
  });

  // Each host keeps its own copy of the reserve's state, and each posts an offer for its own refused
  // write (docs/reserve.md, "Several hosts"). The docs promise the handlers one call until a flush
  // holds what they wrote.
  it.fails("call onStorageFull again only once a flush holds what the handlers wrote", async () => {
    const budget = new BudgetFs(fs, 1 << 30);
    const dbs = await refuseBoth(budget);
    const calls: { readonly flushed: Promise<{ ingestedThrough: number }>; readonly wrote: Promise<number> }[] = [];
    for (const db of dbs) {
      db.onStorageFull(async () => {
        budget.limit += 2 * RESERVE;
        calls.push({ flushed: walMeta(name), wrote: db.put(key(90_000 + calls.length), enc.encode("freed")) });
      });
    }
    await flushBoth(dbs);
    await vi.waitFor(() => expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE), { timeout: 10_000 });
    await Promise.all(dbs.map((db) => settle(db)));

    expect(calls.length).toBeGreaterThan(0);
    for (let i = 1; i < calls.length; i++) {
      expect((await calls[i]!.flushed).ingestedThrough, `call ${i + 1}`).toBeGreaterThanOrEqual(await calls[i - 1]!.wrote);
    }
  });

  // A host knows the `reserveBytes` of its own tabs only (docs/reserve.md, "Several hosts").
  it.fails("keep the largest reserveBytes any open handle passed", async () => {
    const budget = new BudgetFs(fs, 1 << 30);
    const kept = await open(budget, { reserveBytes: RESERVE });
    await putRows(kept, 0, 8);
    await settle(kept);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);

    const none = await open(budget, { reserveBytes: 0 });
    await putRows(none, 8, 16);
    await settle(none);
    await settle(kept);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
  });
});
