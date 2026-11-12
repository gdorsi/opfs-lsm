import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WallClock } from "../src/clock.js";
import { ConstraintError, type ChangeEvent, type Db } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { decodeSst } from "../src/store/sst.js";
import { __resetMemoryFsForTests, createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const NAME = "expiry-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);
const s = (v: Uint8Array | undefined) => (v === undefined ? undefined : dec.decode(v));

const T = 1_700_000_000_000;
/** The time every tab and the host read. Tests move it. */
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

async function open(tabClock: () => number = clock): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, clock: tabClock });
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
  __resetMemoryFsForTests(NAME);
});

const FILLER = "z-filler-";

async function keys(db: Db, range: Parameters<Db["range"]>[0] = {}): Promise<string[]> {
  const out: string[] = [];
  for await (const e of db.range(range)) {
    if (!dec.decode(e.key).startsWith(FILLER)) out.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
  }
  return out;
}

/** Four flushes, so the host merges L0 into L1, the bottom level. */
async function compact(db: Db): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await db.put(b(`${FILLER}${i}`), b("f"));
    await ingest(db);
  }
  expect(fs.publishedPaths().some((p) => p.startsWith("l1/"))).toBe(true);
}

/** Every entry of every run the latest manifest lists, as `kind key`. */
async function stored(): Promise<string[]> {
  const meta = (await loadLatestGeneration(fs))!;
  const out: string[] = [];
  for (const run of meta.runs) {
    for (const e of decodeSst((await fs.read(run.path, 0, Infinity))!)) {
      const k = dec.decode(e.key);
      if (!k.startsWith(FILLER)) out.push(`${e.kind} ${k}${e.kind === "put" && e.expiresAt !== undefined ? ` @${e.expiresAt - T}` : ""}`);
    }
  }
  return out.sort();
}

/** Every read a user has, for key `k`, as one string per read. */
async function reads(db: Db, k: string): Promise<Record<string, unknown>> {
  const joined = await db.rangeJoin({ start: b("a"), endExclusive: b("b") }, () => b(k));
  return {
    get: s(await db.get(b(k))),
    range: await keys(db, { start: b(k), endExclusive: b(`${k}\0`) }),
    reverse: await keys(db, { start: b(k), endExclusive: b(`${k}\0`), reverse: true }),
    contains: await keys(db, { valueContains: [b("v")], start: b(k), endExclusive: b(`${k}\0`) }),
    joined: joined.map((j) => s(j.joined)),
    view: await db.view((snap) => snap.get(b(k)).then(s)),
    update: await db.update([b(k)], ([v]) => s(v)),
  };
}

const present = (k: string, v: string) => ({
  get: v,
  range: [`${k}=${v}`],
  reverse: [`${k}=${v}`],
  contains: [`${k}=${v}`],
  joined: [v],
  view: v,
  update: v,
});
const absent = { get: undefined, range: [], reverse: [], contains: [], joined: [undefined], view: undefined, update: undefined };

/**
 * Where the versions of key `k` sit when they are read: `old` runs after
 * the version that never expires, `young` after the one that does.
 */
const STAGES: Record<string, { old(db: Db): Promise<unknown>; young(db: Db): Promise<unknown> }> = {
  "both in the memtable": { old: async () => {}, young: async () => {} },
  "old flushed, young in the memtable": { old: ingest, young: async () => {} },
  "both flushed": { old: ingest, young: ingest },
  "old compacted, young in the memtable": { old: compact, young: async () => {} },
  "old compacted, young flushed": { old: compact, young: ingest },
  "both compacted": { old: compact, young: compact },
};

describe.each(Object.entries(STAGES))("an expiring put over an older version, %s", (_stage, { old, young }) => {
  it("reads in every read until its deadline, then reads as absent with the older version", async () => {
    const db = await open();
    await db.put(b("a"), b("anchor"));
    await db.put(b("k"), b("v-old"));
    await old(db);
    await db.put(b("k"), b("v-young"), { expiresAt: T + 100 });
    await young(db);

    expect(await reads(db, "k")).toEqual(present("k", "v-young"));
    now = T + 99;
    expect(await reads(db, "k")).toEqual(present("k", "v-young"));
    now = T + 100;
    expect(await reads(db, "k")).toEqual(absent);
  });

  it("stays absent after the flushes and compactions that judge it", async () => {
    const db = await open();
    await db.put(b("a"), b("anchor"));
    await db.put(b("k"), b("v-old"));
    await old(db);
    await db.put(b("k"), b("v-young"), { expiresAt: T + 100 });
    await young(db);
    now = T + 100;
    await ingest(db);
    expect(await reads(db, "k")).toEqual(absent);
    await compact(db);
    expect(await reads(db, "k")).toEqual(absent);
  });
});

describe("expiry in the runs", () => {
  it("a flush keeps a put that has not expired with its expiresAt, and one that has as a tombstone", async () => {
    const db = await open();
    await db.batch((tx) => {
      tx.put(b("later"), b("v"), { expiresAt: T + 100 });
      tx.put(b("gone"), b("v"), { expiresAt: T + 5 });
      tx.put(b("never"), b("v"));
    });
    now = T + 10;
    await ingest(db);
    expect(await stored()).toEqual(["del gone", "put later @100", "put never"]);
    expect((await loadLatestGeneration(fs))!.judgedNow).toBe(T + 10);
  });

  it("a bottom merge drops an expired put and the versions under it", async () => {
    const db = await open();
    await db.put(b("a"), b("anchor"));
    await db.put(b("k"), b("v-old"));
    await ingest(db);
    await db.put(b("k"), b("v-young"), { expiresAt: T + 100 });
    await db.put(b("later"), b("v"), { expiresAt: T + 1000 });
    await ingest(db);
    now = T + 100;
    await compact(db);
    expect(await stored()).toEqual(["put a", "put later @1000"]);
    expect(await reads(db, "later")).toEqual(present("later", "v"));
  });

  it("never lowers a manifest's judgedNow when the host clock goes back", async () => {
    const db = await open();
    await db.put(b("k"), b("v"));
    now = T + 50;
    await ingest(db);
    now = T;
    await db.put(b("j"), b("v"));
    await ingest(db);
    expect((await loadLatestGeneration(fs))!.judgedNow).toBe(T + 50);
  });

  it("a tab whose clock is behind reads at the installed manifest's judgedNow", async () => {
    const db = await open(() => T);
    await db.put(b("k"), b("v"));
    now = T + 200;
    await ingest(db);
    // In the memtable, judged by the tab alone: its clock says T, the manifest says T + 200.
    await db.put(b("late"), b("v"), { expiresAt: T + 150 });
    expect(s(await db.get(b("late")))).toBeUndefined();
    expect(await keys(db)).toEqual(["k=v"]);
  });
});

describe("one read point per operation", () => {
  it("a range keeps the time it started at while the clock moves", async () => {
    const db = await open();
    await db.batch((tx) => {
      for (const k of ["a", "b", "c"]) tx.put(b(k), b("v"), { expiresAt: T + 10 });
    });
    const seen: string[] = [];
    for await (const e of db.range()) {
      seen.push(s(e.key)!);
      now = T + 10;
    }
    expect(seen).toEqual(["a", "b", "c"]);
    expect(await keys(db)).toEqual([]);
  });

  it("a rangeJoin judges its joins at the time of its scan", async () => {
    const db = await open();
    await db.put(b("a"), b("anchor"));
    await db.put(b("j"), b("joined"), { expiresAt: T + 10 });
    await ingest(db);
    const out = await db.rangeJoin({ endExclusive: b("b") }, () => {
      now = T + 10;
      return b("j");
    });
    expect(out.map((j) => s(j.joined))).toEqual(["joined"]);
  });

  it("a view pins its time", async () => {
    const db = await open();
    await db.put(b("k"), b("v"), { expiresAt: T + 10 });
    await db.view(async (snap) => {
      now = T + 10;
      expect(s(await snap.get(b("k")))).toBe("v");
      expect(s(await db.get(b("k")))).toBeUndefined();
      const rows: string[] = [];
      for await (const e of snap.range()) rows.push(s(e.key)!);
      expect(rows).toEqual(["k"]);
    });
  });

  it("an update reads every key at one time", async () => {
    const db = await open();
    await db.put(b("x"), b("v"), { expiresAt: T + 10 });
    await db.put(b("y"), b("v"), { expiresAt: T + 10 });
    await ingest(db);
    let calls = 0;
    const tab = await open(() => (calls++ === 0 ? T : T + 10));
    const seen = await tab.update([b("x"), b("y")], (values) => values.map(s));
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("two handles", () => {
  it("each reads another's expiring put as present before its deadline and absent from it", async () => {
    const a = await open();
    const other = await open();
    await a.put(b("k"), b("v"), { expiresAt: T + 100 });
    await other.sync();
    expect(s(await other.get(b("k")))).toBe("v");
    now = T + 100;
    expect(s(await other.get(b("k")))).toBeUndefined();
    expect(s(await a.get(b("k")))).toBeUndefined();
  });
});

describe("recovery", () => {
  it.each([
    ["in the WAL", async () => {}],
    ["flushed", ingest],
  ])("reopens an expiring put %s with its deadline", async (_where, stage) => {
    const db = await open();
    await db.put(b("k"), b("v-old"));
    await db.put(b("k"), b("v"), { expiresAt: T + 100 });
    await stage(db);
    await db.close();
    const again = await open();
    expect(s(await again.get(b("k")))).toBe("v");
    now = T + 100;
    expect(s(await again.get(b("k")))).toBeUndefined();
    expect(await keys(again)).toEqual([]);
  });
});

describe("the API", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1"])("refuses expiresAt %s with ConstraintError and writes nothing", async (bad) => {
    const db = await open();
    await expect(db.put(b("k"), b("v"), { expiresAt: bad as number })).rejects.toThrow(ConstraintError);
    await expect(db.batch((tx) => tx.put(b("k"), b("v"), { expiresAt: bad as number }))).rejects.toThrow(ConstraintError);
    expect(await db.get(b("k"))).toBeUndefined();
  });

  it("a put without expiresAt never expires", async () => {
    const db = await open();
    await db.put(b("k"), b("v"), {});
    now = Number.MAX_SAFE_INTEGER;
    expect(s(await db.get(b("k")))).toBe("v");
  });

  it("change events carry a put's expiresAt", async () => {
    const db = await open();
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));
    await db.batch((tx) => {
      tx.put(b("x"), b("v"), { expiresAt: T + 5 });
      tx.put(b("y"), b("v"));
    });
    const append = events.find((e) => e.kind === "append");
    expect(append?.kind === "append" && append.ops.map((op) => (op.type === "put" ? op.expiresAt : "-"))).toEqual([T + 5, undefined]);
  });
});
