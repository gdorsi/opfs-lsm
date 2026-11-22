import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintError, prefixBound, type ChangeEvent, type Db, type Range } from "../src/index.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { decodeSst } from "./oracle/sst-ref.js";
import {
  __resetMemoryFsForTests,
  createLocalIngestClient,
  EngineHost,
  ingest,
  MemoryFs,
  openHarnessDb,
  readStats,
  settle,
  type AsyncFs,
} from "../src/testing.js";

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
  "rows compacted, delete flushed": { before: compact, after: ingest },
  "rows and delete compacted": { before: compact, after: compact },
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
    const joined = await db.view((snap) => snap.rangeJoin({ endExclusive: b("b") }, () => b("m/2")));
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

/** `inner` with every compaction output stopped at its creation while `hold` is set. */
function compactionGate(inner: MemoryFs) {
  const gate = { hold: undefined as Promise<void> | undefined, stopped: false };
  const fs: AsyncFs = {
    read: (path, offset, length) => inner.read(path, offset, length),
    open: (path) => inner.open(path),
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: async (path) => {
      if (gate.hold && !path.startsWith("l0/") && !path.startsWith("m/")) {
        gate.stopped = true;
        await gate.hold;
      }
      return inner.create(path);
    },
  };
  return { fs, gate };
}

/** Run file reads and bytes this tab made so far. */
async function runReads(db: Db): Promise<{ reads: number; bytes: number }> {
  const out = { reads: 0, bytes: 0 };
  for (const [kind, io] of Object.entries((await readStats(db)).tab.fs!.read)) {
    if (!/^l\d+$/.test(kind)) continue;
    out.reads += io.calls;
    out.bytes += io.bytes;
  }
  return out;
}

describe("a flush that a range delete overtakes", () => {
  it("keeps the delete's mark when the tab installs the flush, so the rows it covers stay hidden", async () => {
    let release!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const stopped = new Promise<void>((r) => (reached = r));
    let first = true;
    const gated: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: async (path) => {
        if (first && path.startsWith("l0/")) {
          first = false;
          reached();
          await hold;
        }
        return fs.create(path);
      },
    };
    const host = new EngineHost(() => gated);
    const db = await openHarnessDb({ name: NAME, fs: gated, ingest: createLocalIngestClient(host), writerId: "w1", maxWalBytes: 1 << 30 });
    opened.push(db);
    await writeRows(db);
    // A mark the flush folds, so installing it retires marks.
    await db.batch((tx) => tx.deleteRange({ start: b("a"), endExclusive: b("b") }));
    const flushing = ingest(db);
    await stopped;
    // One seq past the flush: the installed run holds the rows it covers, and only the memtable's mark hides them.
    await db.batch((tx) => tx.deleteRange(M));
    release();
    await flushing;
    await db.sync();
    expect(await keys(db)).toEqual(["z=v:z"]);
    expect(await db.get(b("m/1"))).toBeUndefined();
  });
});

describe("a scan over a range delete", () => {
  const value = (k: string) => b(`v:${k}:`.padEnd(300, "."));

  it("reads no page of a run the delete covers within the scan, and reads a run it covers in part", async () => {
    const { fs: gated, gate } = compactionGate(fs);
    const host = new EngineHost(() => gated);
    const tab = async (writerId: string) => {
      const db = await openHarnessDb({ name: NAME, fs: gated, ingest: createLocalIngestClient(host), writerId, maxWalBytes: 1 << 30 });
      opened.push(db);
      return db;
    };
    /** `range` on a new handle, whose page cache is empty, and the run reads it made. */
    const cold = async (range: Range) => {
      const db = await tab(`cold-${opened.length}`);
      const before = await runReads(db);
      const rows = await keys(db, range);
      const after = await runReads(db);
      return { rows, reads: after.reads - before.reads, bytes: after.bytes - before.bytes };
    };
    const db = await tab("w1");
    await db.batch((tx) => {
      for (const k of ["a", "z"]) tx.put(b(k), b(`v:${k}`));
      for (let i = 0; i < 300; i++) tx.put(b(`m/${String(i).padStart(3, "0")}`), value(String(i)));
    });
    await host.ingest(NAME, true);
    await db.batch((tx) => {
      tx.deleteRange(M);
      tx.put(b("m/150"), b("new"));
    });

    for (const range of [M, { ...M, reverse: true }, { ...M, valueContains: [b("new")] }, { ...M, valueContains: [b("v:")] }]) {
      const rows = range.valueContains?.[0]?.[0] === 0x76 ? [] : ["m/150=new"];
      expect(await cold(range), "the delete in the memtable").toEqual({ rows, reads: 0, bytes: 0 });
    }
    const whole = await cold({});
    expect(whole.rows).toEqual(["a=v:a", "m/150=new", "z=v:z"]);
    expect(whole.reads, "a scan past the delete's range reads the run").toBeGreaterThan(0);

    let release!: () => void;
    gate.hold = new Promise((resolve) => (release = resolve));
    await host.ingest(NAME);
    await vi.waitFor(() => expect(gate.stopped).toBe(true));
    const meta = (await loadLatestGeneration(fs))!;
    expect(meta.runs.map((r) => r.path.slice(0, 3))).toEqual(["l0/", "l0/"]);
    expect(meta.marks).toHaveLength(1);
    const flushed = await cold(M);
    expect(flushed.rows).toEqual(["m/150=new"]);
    expect(flushed.bytes, "the delete flushed: only the run that holds m/150 is read").toBeGreaterThan(0);
    expect(flushed.bytes).toBeLessThanOrEqual(2 * meta.runs[0]!.bytes);
    expect(await cold({ ...M, reverse: true })).toMatchObject({ rows: ["m/150=new"], bytes: flushed.bytes });
    gate.hold = undefined;
    release();
    await host.ingest(NAME, true);
  });

  it("reads a run that holds a version newer than the delete's `through`", async () => {
    const db = await open();
    const through = await db.batch((tx) => {
      for (let i = 0; i < 300; i++) tx.put(b(`m/${String(i).padStart(3, "0")}`), value(String(i)));
    });
    await db.put(b("m/200"), b("after"));
    await ingest(db);
    await db.batch((tx) => tx.deleteRange(M, { through }));

    expect(await keys(db, M)).toEqual(["m/200=after"]);
    expect(await keys(db, { ...M, reverse: true })).toEqual(["m/200=after"]);
    expect(await keys(db, { ...M, valueContains: [b("after")] })).toEqual(["m/200=after"]);
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

  it("gives its space back once compaction settles: rows leave the disk and the mark retires", async () => {
    const db = await open();
    const oracle = new Map<string, string>();
    const value = (k: string) => `${k}:${"x".repeat(200)}`;
    for (let chunk = 0; chunk < 8; chunk++) {
      await db.batch((tx) => {
        for (let i = 0; i < 300; i++) {
          const k = `big/${String(chunk * 300 + i).padStart(5, "0")}`;
          tx.put(b(k), b(value(k)));
          oracle.set(k, value(k));
        }
        for (const k of [`a/${chunk}`, `c/${chunk}`]) {
          tx.put(b(k), b(value(k)));
          oracle.set(k, value(k));
        }
      });
      await ingest(db);
    }
    await settle(db);
    const disk = async () => {
      const meta = (await loadLatestGeneration(fs))!;
      let entries = 0;
      for (const run of meta.runs) entries += decodeSst((await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!).length;
      return { meta, entries, bytes: meta.runs.reduce((n, r) => n + r.bytes, 0) };
    };
    const before = await disk();
    expect(before.entries).toBe(oracle.size);
    expect(before.meta.runs.every((r) => !r.path.startsWith("l0/")), "the rows sit in compacted runs").toBe(true);

    await db.batch((tx) => tx.deleteRange(prefixBound(b("big/"))));
    for (const k of [...oracle.keys()]) if (k.startsWith("big/")) oracle.delete(k);
    await settle(db);

    const after = await disk();
    expect(after.meta.marks, "the mark retired").toEqual([]);
    expect(after.entries).toBe(oracle.size);
    expect(after.bytes).toBeLessThan(before.bytes / 20);
    const want = [...oracle].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`);
    const reads = async (db: Db) => {
      expect(await keys(db)).toEqual(want);
      expect(await keys(db, { reverse: true })).toEqual([...want].reverse());
      expect(await keys(db, { valueContains: [b(":x")] })).toEqual(want);
      for (const k of ["big/00000", "big/02399", "a/3", "c/7"]) expect(s(await db.get(b(k)))).toBe(oracle.get(k));
    };
    await reads(db);
    await db.close();
    opened.splice(0);
    await reads(await open("w2"));
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
  it("keeps rewriting past one pass's step limit: ten runs under one range delete, no further writes", async () => {
    const db = await open();
    // Forty disjoint groups, four per flush merge: ten L1 runs, more than the eight steps of a pass.
    for (let g = 0; g < 40; g++) {
      await db.put(b(`g/${String(g).padStart(2, "0")}`), b("x".repeat(100)));
      await ingest(db);
    }
    await settle(db);
    const disk = async () => {
      const meta = (await loadLatestGeneration(fs))!;
      return { meta, bytes: meta.runs.reduce((n, r) => n + r.bytes, 0) };
    };
    const before = await disk();
    expect(before.meta.runs.length, "more runs than one pass rewrites").toBeGreaterThan(8);

    await db.batch((tx) => tx.deleteRange(prefixBound(b("g/"))));
    // One flush and no `settle`, which would start the passes the host must start itself.
    await ingest(db);

    const after = await disk();
    expect(after.meta.marks, "the mark retired").toEqual([]);
    expect(after.bytes).toBeLessThan(before.bytes / 20);
  });

});
