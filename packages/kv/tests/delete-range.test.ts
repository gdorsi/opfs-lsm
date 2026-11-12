import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError, prefixBound, type ChangeEvent, type Db } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { throughAt } from "../src/store/marks.js";
import { __resetMemoryFsForTests, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const NAME = "delete-range-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);
const s = (v: Uint8Array | undefined) => (v === undefined ? undefined : dec.decode(v));

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

let fs: MemoryFs;
const opened: Db[] = [];

async function open(writerId = "w1"): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, fs, writerId, maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  fs = new MemoryFs();
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  __resetMemoryFsForTests(NAME);
});

const FILLER = "z-filler-";

/** `key=value` of each entry `range` yields, without the rows `compact` writes. */
async function keys(db: Db, range: Parameters<Db["range"]>[0] = {}): Promise<string[]> {
  const out: string[] = [];
  for await (const e of db.range(range)) {
    if (!dec.decode(e.key).startsWith(FILLER)) out.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
  }
  return out;
}

/** Four flushes, so the host merges L0 into L1. */
async function compact(db: Db): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await db.put(b(`${FILLER}${i}`), b("f"));
    await ingest(db);
  }
  expect(fs.publishedPaths().some((p) => p.startsWith("l1/"))).toBe(true);
}

/**
 * Where the rows and the range delete sit when they are read: `before` runs
 * after the rows are written, `after` after the range delete.
 */
const STAGES: Record<string, { before(db: Db): Promise<unknown>; after(db: Db): Promise<unknown> }> = {
  "rows and delete in the memtable": { before: async () => {}, after: async () => {} },
  "rows flushed, delete in the memtable": { before: ingest, after: async () => {} },
  "rows and delete flushed": { before: ingest, after: ingest },
  "rows in the memtable, delete flushed with them": { before: async () => {}, after: ingest },
};

const ROWS = ["a", "m/1", "m/2", "m/3", "z"];
const M = prefixBound(b("m/"));

async function writeRows(db: Db, tag = "v"): Promise<number> {
  return db.batch((tx) => {
    for (const k of ROWS) tx.put(b(k), b(`${tag}:${k}`));
  });
}

describe.each(Object.entries(STAGES))("deleteRange, %s", (_stage, { before, after }) => {
  it("hides the rows in the range from every read", async () => {
    const db = await open();
    await writeRows(db);
    await before(db);
    await db.batch((tx) => tx.deleteRange(M));
    await after(db);

    for (const k of ROWS) expect(s(await db.get(b(k)))).toBe(k.startsWith("m/") ? undefined : `v:${k}`);
    expect(await keys(db)).toEqual(["a=v:a", "z=v:z"]);
    expect(await keys(db, { reverse: true })).toEqual(["z=v:z", "a=v:a"]);
    expect(await keys(db, { reverse: true, limit: 1, endExclusive: b("y") })).toEqual(["a=v:a"]);
    expect(await keys(db, { limit: 1 })).toEqual(["a=v:a"]);
    expect(await keys(db, { valueContains: [b("v:")] })).toEqual(["a=v:a", "z=v:z"]);
    expect(await keys(db, { valueContains: [b("v:m")] })).toEqual([]);
    const joined = await db.rangeJoin({ endExclusive: b("b") }, () => b("m/2"));
    expect(joined.map((j) => [s(j.entry.key), s(j.joined)])).toEqual([["a", undefined]]);
    const seen = await db.update([b("m/1"), b("a")], (values) => values.map(s));
    expect(seen).toEqual([undefined, "v:a"]);
  });

  it("keeps its own batch's puts and the rows written after `through`", async () => {
    const db = await open();
    const first = await db.put(b("m/1"), b("old"));
    await db.put(b("m/2"), b("kept"));
    await before(db);
    await db.batch((tx) => {
      tx.put(b("m/3"), b("same batch"));
      tx.deleteRange(M, { through: first });
    });
    await after(db);

    expect(s(await db.get(b("m/1")))).toBeUndefined();
    expect(s(await db.get(b("m/2")))).toBe("kept");
    expect(s(await db.get(b("m/3")))).toBe("same batch");
    expect(await keys(db, M)).toEqual(["m/2=kept", "m/3=same batch"]);
  });

  it("lets a later put into the range be read, and no older version comes back", async () => {
    const db = await open();
    await writeRows(db, "old");
    await before(db);
    await writeRows(db, "new");
    await before(db);
    await db.batch((tx) => tx.deleteRange(M));
    await after(db);
    expect(await keys(db, M)).toEqual([]);
    await db.put(b("m/2"), b("again"));
    await after(db);

    expect(s(await db.get(b("m/1")))).toBeUndefined();
    expect(s(await db.get(b("m/2")))).toBe("again");
    expect(await keys(db, M)).toEqual(["m/2=again"]);
    expect(await keys(db, { ...M, reverse: true })).toEqual(["m/2=again"]);
  });

  it("leaves a view opened before the delete reading the rows", async () => {
    const db = await open();
    await writeRows(db);
    await before(db);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = db.view(async (snap) => {
      await held;
      const out: string[] = [];
      for await (const e of snap.range(M)) out.push(dec.decode(e.key));
      return { got: s(await snap.get(b("m/2"))), keys: out };
    });
    await db.batch((tx) => tx.deleteRange(M));
    await after(db);
    release();
    expect(await read).toEqual({ got: "v:m/2", keys: ["m/1", "m/2", "m/3"] });
    expect(await db.get(b("m/2"))).toBeUndefined();
  });

  it("reaches a second handle after sync, and survives a reopen", async () => {
    const a = await open("w1");
    await writeRows(a);
    await before(a);
    const other = await open("w2");
    await a.batch((tx) => tx.deleteRange(M));
    await after(a);
    await other.sync();
    expect(await keys(other, M)).toEqual([]);
    expect(s(await other.get(b("a")))).toBe("v:a");

    for (const db of opened.splice(0)) await db.close();
    const again = await open("w3");
    expect(await keys(again, M)).toEqual([]);
    expect(await keys(again)).toEqual(["a=v:a", "z=v:z"]);
  });
});

describe("deleteRange", () => {
  it("reports the op with its resolved `through` in changes()", async () => {
    const db = await open();
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));
    const first = await db.put(b("m/1"), b("x"));
    const seq = await db.batch((tx) => tx.deleteRange({ start: b("m/"), endExclusive: b("m0") }));
    const asked = await db.batch((tx) => tx.deleteRange({ start: b("q") }, { through: first }));
    const last = events.filter((e) => e.kind === "append").slice(-2);
    expect(last).toEqual([
      { kind: "append", seq, ops: [{ type: "deleteRange", start: b("m/"), endExclusive: b("m0"), through: seq - 1 }] },
      { kind: "append", seq: asked, ops: [{ type: "deleteRange", start: b("q"), through: first }] },
    ]);
  });

  it("caps an asked `through` below its own batch", async () => {
    const db = await open();
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));
    const seq = await db.batch((tx) => {
      tx.put(b("m/1"), b("x"));
      tx.deleteRange(M, { through: Number.MAX_SAFE_INTEGER - 1 });
    });
    expect(s(await db.get(b("m/1")))).toBe("x");
    const op = events.find((e) => e.kind === "append")!;
    expect(op).toMatchObject({ seq, ops: [{ type: "put" }, { type: "deleteRange", through: seq - 1 }] });
  });

  it("rejects an empty or inverted range and a bad `through`", async () => {
    const db = await open();
    await expect(db.batch((tx) => tx.deleteRange({ start: b("b"), endExclusive: b("b") }))).rejects.toThrow(ConstraintError);
    await expect(db.batch((tx) => tx.deleteRange({ start: b("c"), endExclusive: b("b") }))).rejects.toThrow(ConstraintError);
    await expect(db.batch((tx) => tx.deleteRange({}, { through: -1 }))).rejects.toThrow(ConstraintError);
    await expect(db.batch((tx) => tx.deleteRange({}, { through: 1.5 }))).rejects.toThrow(ConstraintError);
  });

  it("leaves the manifest once every run that overlaps its range was written after it", async () => {
    const db = await open();
    await db.put(b("q/1"), b("flushed before"));
    await ingest(db);
    await db.batch((tx) => tx.deleteRange(prefixBound(b("q/"))));
    await writeRows(db);
    await db.batch((tx) => tx.deleteRange(M));
    await db.put(b("m/9"), b("after"));
    await ingest(db);

    const { marks } = (await loadLatestGeneration(fs))!;
    expect(throughAt(marks, b("q/1"))).toBeGreaterThan(0);
    expect(throughAt(marks, b("m/1"))).toBe(0);
    expect(await keys(db, M)).toEqual(["m/9=after"]);
    expect(await keys(db, prefixBound(b("q/")))).toEqual([]);
  });

  it("with no bounds removes every row written before it", async () => {
    const db = await open();
    await writeRows(db);
    await db.batch((tx) => {
      tx.deleteRange({});
      tx.put(b("n"), b("new"));
    });
    expect(await keys(db)).toEqual(["n=new"]);
  });
});
