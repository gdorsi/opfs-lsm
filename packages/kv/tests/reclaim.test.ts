import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WallClock } from "../src/clock.js";
import { prefixBound, type Db } from "../src/index.js";
import { hostBudget, DEFAULT_COMPACTION_MEMORY_BYTES } from "../src/host/budget.js";
import { mergeNextStep } from "../src/host/compact.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { decodeSst } from "../src/store/sst.js";
import { __resetMemoryFsForTests, createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, settle } from "../src/testing.js";
import { checkDatabase, walMeta } from "./sim/check-database.js";

/**
 * The space of dead rows in runs whose level is in shape: expired puts,
 * tombstones and rows a range delete covers leave the disk at the next
 * compaction pass, and every read agrees with what was written.
 */

const NAME = "reclaim-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);

const T = 1_700_000_000_000;
let now = T;
const clock = () => now;

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

let fs: MemoryFs;
let host: EngineHost;
const opened: Db[] = [];

async function open(): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, clock });
  opened.push(db);
  return db;
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  now = T;
  fs = new MemoryFs();
  host = new EngineHost(() => fs, {}, new WallClock(clock));
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  await host.opened();
  __resetMemoryFsForTests(NAME);
});

const pad = (i: number) => String(i).padStart(5, "0");
const VALUE = "x".repeat(120);

/** The latest manifest's run bytes, its entries by key prefix, and its levels. */
async function disk() {
  const meta = (await loadLatestGeneration(fs))!;
  const prefixes = new Map<string, number>();
  for (const run of meta.runs) {
    for (const e of decodeSst((await fs.read(run.path, 0, Infinity))!)) {
      const p = dec.decode(e.key).split("/")[0]!;
      prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
    }
  }
  return { meta, bytes: meta.runs.reduce((n, r) => n + r.bytes, 0), entries: Object.fromEntries(prefixes), paths: meta.runs.map((r) => r.path) };
}

async function keys(db: Db, range: Parameters<Db["range"]>[0] = {}): Promise<string[]> {
  const out: string[] = [];
  for await (const e of db.range(range)) out.push(dec.decode(e.key));
  return out;
}

/** Every read agrees that exactly `want` is there, in order. */
async function expectReads(db: Db, want: readonly string[], probes: readonly string[]): Promise<void> {
  expect(await keys(db)).toEqual(want);
  expect(await keys(db, { reverse: true })).toEqual([...want].reverse());
  const there = new Set(want);
  const got: Record<string, boolean> = {};
  for (const k of probes) got[k] = (await db.get(b(k))) !== undefined;
  expect(got).toEqual(Object.fromEntries(probes.map((k) => [k, there.has(k)])));
  expect(await db.view(async (snap) => (await snap.get(b(probes[0]!))) !== undefined)).toBe(there.has(probes[0]!));
}

/** `e/` rows that expire at T + 100 and `k/` rows that never do, flushed four times and merged into L1. */
async function expiringInL1(db: Db): Promise<string[]> {
  const kept: string[] = [];
  for (let chunk = 0; chunk < 4; chunk++) {
    await db.batch((tx) => {
      for (let i = 0; i < 400; i++) tx.put(b(`e/${pad(chunk * 400 + i)}`), b(VALUE), { expiresAt: T + 100 });
      for (let i = 0; i < 50; i++) {
        const k = `k/${pad(chunk * 50 + i)}`;
        tx.put(b(k), b(VALUE));
        kept.push(k);
      }
    });
    await ingest(db);
  }
  await settle(db);
  expect((await disk()).paths.every((p) => p.startsWith("l1/")), "the rows sit in L1, in shape").toBe(true);
  return kept;
}

const PROBES = ["e/00000", "e/00799", "e/01599", "k/00000", "k/00123", "k/00199"];

describe("expired rows", () => {
  it("leave the disk at the next compaction pass, and every read agrees", async () => {
    const db = await open();
    const kept = await expiringInL1(db);
    const before = await disk();
    now = T + 100;
    await settle(db);
    const after = await disk();
    expect(after.entries).toEqual({ k: kept.length });
    expect(after.bytes).toBeLessThan(before.bytes / 4);
    await expectReads(db, kept, PROBES);
  });

  it("leave the disk when an open starts a pass, with no write", async () => {
    const kept = await expiringInL1(await open());
    for (const db of opened.splice(0)) await db.close();
    const before = await disk();
    now = T + 100;
    const db = await open();
    await host.opened();
    const after = await disk();
    expect(after.meta.generation).toBeGreaterThan(before.meta.generation);
    expect(after.entries).toEqual({ k: kept.length });
    expect((await walMeta(NAME)).head).toBe((await walMeta(NAME)).ingestedThrough);
    await expectReads(db, kept, PROBES);
  });

  it("stay on disk until a pass, and read as absent meanwhile", async () => {
    const db = await open();
    const kept = await expiringInL1(db);
    const before = await disk();
    now = T + 100;
    expect((await disk()).bytes).toBe(before.bytes);
    await expectReads(db, kept, PROBES);
  });

  it("still read in a view pinned before the purge", async () => {
    const db = await open();
    const kept = await expiringInL1(db);
    now = T + 50;
    const seen = await db.view(async (snap) => {
      now = T + 200;
      await settle(db);
      expect((await disk()).entries).toEqual({ k: kept.length });
      return { e: await snap.get(b("e/00042")), count: (await keys(db)).length };
    });
    expect(seen.e).toEqual(b(VALUE));
    expect(seen.count).toBe(kept.length);
    await expectReads(db, kept, PROBES);
  });

  it("survive a crash between the purge's write and its install", async () => {
    const db = await open();
    const kept = await expiringInL1(db);
    const before = await disk();
    now = T + 100;
    // The purge writes its runs, and the context dies before it installs them.
    const step = await mergeNextStep(fs, hostBudget(DEFAULT_COMPACTION_MEMORY_BYTES), before.meta, 0, new WallClock(clock));
    expect(step?.outputs.length).toBeGreaterThan(0);
    for (const d of opened.splice(0)) await d.close();
    host = new EngineHost(() => fs, {}, new WallClock(clock));

    const again = await open();
    await expectReads(again, kept, PROBES);
    expect((await disk()).meta.generation).toBeGreaterThanOrEqual(before.meta.generation);
    await settle(again);
    await host.opened();
    expect((await disk()).entries).toEqual({ k: kept.length });
    await expectReads(again, kept, PROBES);
    for (const d of opened.splice(0)) await d.close();
    const report = await checkDatabase(fs, NAME, now);
    expect(report.problems).toEqual([]);
    expect(report.orphans, "the purge's unlisted runs were reclaimed").toEqual([]);
  });
});

describe("tombstones", () => {
  it("over a deeper level go down to the rows they delete and take them off the disk", async () => {
    // A small L1 target, so the rows sit in L2 and the deletes merge into L1 above them.
    host = new EngineHost(() => fs, { l1TargetBytes: 64 * 1024 }, new WallClock(clock));
    const db = await open();
    const all: string[] = [];
    for (let chunk = 0; chunk < 4; chunk++) {
      await db.batch((tx) => {
        for (let i = 0; i < 500; i++) {
          const k = `k/${pad(chunk * 500 + i)}`;
          tx.put(b(k), b(VALUE));
          all.push(k);
        }
      });
      await ingest(db);
    }
    await settle(db);
    const before = await disk();
    expect(before.paths.some((p) => p.startsWith("l2/")), "the rows sit in L2").toBe(true);
    for (let chunk = 0; chunk < 4; chunk++) {
      await db.batch((tx) => {
        for (const k of all.slice(100 + chunk * 475, 100 + (chunk + 1) * 475)) tx.delete(b(k));
      });
      await ingest(db);
    }
    await settle(db);
    const after = await disk();
    expect(after.entries).toEqual({ k: 100 });
    expect(after.bytes).toBeLessThan(before.bytes / 5);
    await expectReads(db, all.slice(0, 100), ["k/00000", "k/00099", "k/00100", "k/01999"]);
  });
});

describe("range deletes", () => {
  it("remove a run they wholly cover without a merge", async () => {
    const db = await open();
    await db.batch((tx) => {
      for (let i = 0; i < 300; i++) tx.put(b(`e/${pad(i)}`), b(VALUE));
    });
    await ingest(db);
    await db.put(b("k/00001"), b(VALUE));
    await ingest(db);
    const before = await disk();
    expect(before.paths).toHaveLength(2);
    await db.batch((tx) => tx.deleteRange(prefixBound(b("e/"))));
    await settle(db);
    const after = await disk();
    expect(after.meta.marks.empty, "the mark retired").toBe(true);
    expect(after.paths, "the covered run left and nothing was merged").toEqual(before.paths.filter((p) => p !== before.paths[1]));
    expect(fs.publishedPaths().filter((p) => p.endsWith(".sst"))).toEqual(after.paths);
    expect(after.entries).toEqual({ k: 1 });
    await expectReads(db, ["k/00001"], ["e/00000", "e/00299", "k/00001"]);
  });

  it("over most of a compacted run reclaim its space, and every read agrees", async () => {
    const db = await open();
    const kept = await expiringInL1(db);
    const before = await disk();
    await db.batch((tx) => tx.deleteRange(prefixBound(b("e/"))));
    await settle(db);
    const after = await disk();
    expect(after.meta.marks.empty).toBe(true);
    expect(after.entries).toEqual({ k: kept.length });
    expect(after.bytes).toBeLessThan(before.bytes / 4);
    await expectReads(db, kept, PROBES);
  });
});
