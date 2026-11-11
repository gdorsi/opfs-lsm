import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient, openHarnessDb, __resetMemoryFsForTests, ingest } from "../src/testing.js";
import type { OpenFile } from "../src/opfs/async-fs.js";
import type { PageCache } from "../src/store/page-cache.js";
import type { Db } from "../src/index.js";
import { collect } from "./runs.js";

const NAME = "memory-budget";
const enc = new TextEncoder();
const dec = new TextDecoder();
const MiB = 1024 * 1024;
const ROWS_PER_RUN = 1500;
const RUNS = 3;

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

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

/** Run file reads, in the order they start and land. */
class TracingFs extends MemoryFs {
  events: ("start" | "end")[] = [];

  override async open(path: string): Promise<OpenFile | undefined> {
    const file = await super.open(path);
    if (!file) return undefined;
    return {
      size: file.size,
      read: async (offset, length) => {
        this.events.push("start");
        try {
          return await file.read(offset, length);
        } finally {
          this.events.push("end");
        }
      },
      close: () => file.close(),
    };
  }
}

const key = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);

let seed = 7;
/** Uppercase letters, so a lowercase search token never matches by chance. */
function filler(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    s += String.fromCharCode(65 + (seed >>> 24) % 26);
  }
  return s;
}

const valueOf = (i: number, tag: string) => ` ${tag} t${i % 5} ${filler(1000)}`;

/** Three overlapping L0 runs of about 1.5 MB each, then a few memtable writes over them. */
async function seed3Runs(fs: TracingFs, host: EngineHost, cacheBytes: number) {
  const model = new Map<string, string>();
  const db = await open(fs, host, cacheBytes);
  for (let r = 0; r < RUNS; r++) {
    await db.batch((tx) => {
      for (let j = 0; j < ROWS_PER_RUN; j++) {
        const i = j * RUNS + r;
        const v = valueOf(i, `r${r}`);
        tx.put(key(i), enc.encode(v));
        model.set(dec.decode(key(i)), v);
      }
    });
    await ingest(db);
  }
  for (let i = 0; i < 300; i += 7) {
    await db.put(key(i), enc.encode(" mem t9"));
    model.set(dec.decode(key(i)), " mem t9");
  }
  for (let i = 3; i < 300; i += 11) {
    await db.delete(key(i));
    model.delete(dec.decode(key(i)));
  }
  return { db, model };
}

function open(fs: TracingFs, host: EngineHost, cacheBytes: number): Promise<Db> {
  return openHarnessDb({
    name: NAME,
    writerId: "w1",
    fs,
    ingest: createLocalIngestClient(host),
    maxWalBytes: 1e12,
    cacheBytes,
  });
}

const usage = (db: Db) => (db as unknown as { cache: PageCache }).cache.usage();

function expectWithinBudget(db: Db): void {
  const u = usage(db);
  expect(u.resident).toBeLessThanOrEqual(Math.max(u.budget, u.pinned));
}

const sorted = (model: Map<string, string>) => [...model].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const show = (rows: { key: Uint8Array; value: Uint8Array }[]) => rows.map((r) => `${dec.decode(r.key)}=${dec.decode(r.value)}`);

describe("cacheBytes smaller than one run", () => {
  it("answers get, range, search and update correctly while it evicts", async () => {
    const fs = new TracingFs();
    const host = new EngineHost(() => fs);
    const { db, model } = await seed3Runs(fs, host, MiB);
    const runs = fs.publishedPaths().filter((p) => p.startsWith("l0/"));
    expect(runs).toHaveLength(RUNS);
    for (const p of runs) expect((await fs.read(p, 0, Infinity))!.byteLength).toBeGreaterThan(MiB);

    for (let i = 0; i < ROWS_PER_RUN * RUNS; i += 13) {
      const got = await db.get(key(i));
      expect(got && dec.decode(got)).toBe(model.get(dec.decode(key(i))));
      expectWithinBudget(db);
    }

    const all = sorted(model);
    for (const from of [0, 1234, 4000]) {
      const want = all.filter(([k]) => k >= dec.decode(key(from))).slice(0, 20).map(([k, v]) => `${k}=${v}`);
      expect(show(await collect(db.range({ start: key(from), limit: 20 })))).toEqual(want);
      expectWithinBudget(db);
    }

    const full = await collect(db.range());
    expect(show(full)).toEqual(all.map(([k, v]) => `${k}=${v}`));
    expectWithinBudget(db);

    const t3 = await collect(db.range({ valueContains: [enc.encode(" t3 ")] }));
    expect(show(t3)).toEqual(all.filter(([, v]) => v.includes(" t3 ")).map(([k, v]) => `${k}=${v}`));
    expect(show(await collect(db.range({ valueContains: [enc.encode(" r1 "), enc.encode(" t2 ")], limit: 5 })))).toEqual(
      all.filter(([, v]) => v.includes(" r1 ") && v.includes(" t2 ")).slice(0, 5).map(([k, v]) => `${k}=${v}`),
    );
    expectWithinBudget(db);

    const keys = [key(1000), key(2001), key(3002)];
    const seen = await db.update(keys, (values, tx) => {
      tx.put(keys[0]!, enc.encode(" updated"));
      return values.map((v) => v && dec.decode(v));
    });
    expect(seen).toEqual(keys.map((k) => model.get(dec.decode(k))));
    expect(dec.decode((await db.get(keys[0]!))!)).toBe(" updated");
    expectWithinBudget(db);

    await db.close();
  });
});

describe("scan resistance", () => {
  it("a full scan larger than the budget does not evict pages that gets reuse", async () => {
    const fs = new TracingFs();
    const host = new EngineHost(() => fs);
    const { db } = await seed3Runs(fs, host, MiB);
    const hot = [key(1000), key(2001), key(3002)];
    for (let i = 0; i < 2; i++) for (const k of hot) await db.get(k);

    await collect(db.range());
    await collect(db.range({ valueContains: [enc.encode(" t1 ")] }));
    fs.events = [];
    for (const k of hot) await db.get(k);
    expect(fs.events).toEqual([]);
    await db.close();
  });
});

describe("cold reads", () => {
  it("opening reads no run bytes, and a cold range with a limit starts every run's first read in one round", async () => {
    const fs = new TracingFs();
    const host = new EngineHost(() => fs);
    const { db } = await seed3Runs(fs, host, MiB);
    await db.close();

    fs.events = [];
    const cold = await open(fs, host, MiB);
    expect(fs.events).toEqual([]);

    const rows = await collect(cold.range({ limit: 20 }));
    expect(rows).toHaveLength(20);
    const firstRound = fs.events.indexOf("end");
    expect(firstRound).toBe(RUNS);
    await cold.close();
  });
});
