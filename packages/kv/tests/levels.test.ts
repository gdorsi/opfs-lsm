import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests, ingest, MemoryFs } from "../src/testing.js";
import { loadLatestGeneration, type RunMeta } from "../src/store/generation.js";
import { planCompaction, replaceRuns, type CompactionPlan, type MergePlan } from "../src/store/levels.js";
import { listedRun } from "./runs.js";
import { markTable, NO_MARKS } from "../src/store/marks.js";
import { decodeSst, type SstEntry } from "../src/store/sst.js";

const enc = new TextEncoder();

const run = (path: string, bytes: number, smallest: string, largest?: string): RunMeta =>
  listedRun(path, bytes, largest === undefined ? { smallest } : { smallest, largest });
const paths = (plan: CompactionPlan | undefined) => plan?.inputs.map((r) => r.path);
const merge = (plan: CompactionPlan | undefined): MergePlan | undefined => (plan?.kind === "merge" ? plan : undefined);
const manifest = (runs: readonly RunMeta[]) => ({ runs, marks: NO_MARKS });
const NOW = 1_000;

describe("planCompaction", () => {
  const l0 = (n: number) => Array.from({ length: n }, (_, i) => run(`l0/${10 - i}.sst`, 100, "c", "f"));
  const limits = { maxSources: 49 };

  it("leaves fewer than four L0 runs alone", () => {
    expect(planCompaction(manifest([...l0(3), run("l1/c1.sst", 100, "a", "z")]), NOW, limits)).toBeUndefined();
  });

  it("merges four L0 runs with only the L1 runs they overlap", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "d", "e"), run("l1/c.sst", 100, "x", "z")];
    const plan = merge(planCompaction(manifest([...l0(4), ...l1]), NOW, limits));
    expect(paths(plan)).toEqual([...l0(4).map((r) => r.path), "l1/b.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(plan?.bottom).toBe(true);
  });

  it("is a bottom merge only when no deeper run overlaps the inputs", () => {
    const l1 = run("l1/a.sst", 100, "c", "d");
    expect(merge(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900, "x", "z")]), NOW, limits))?.bottom).toBe(true);
    expect(merge(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900, "e", "g")]), NOW, limits))?.bottom).toBe(false);
    expect(merge(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900, "a", "z")]), NOW, limits))?.bottom).toBe(false);
  });

  it("pushes the oversized level's run with the least overlap below it", () => {
    const runs = [
      run("l1/a.sst", 600, "a", "f"),
      run("l1/b.sst", 600, "g", "m"),
      run("l2/a.sst", 5000, "a", "c"),
      run("l2/b.sst", 100, "h", "i"),
      run("l2/c.sst", 100, "j", "k"),
    ];
    const plan = merge(planCompaction(manifest(runs), NOW, { ...limits, l1Target: 1000 }));
    expect(paths(plan)).toEqual(["l1/b.sst", "l2/b.sst", "l2/c.sst"]);
    expect(plan?.outputLevel).toBe(2);
    expect(planCompaction(manifest(runs.slice(1)), NOW, { ...limits, l1Target: 1000 })).toBeUndefined();
  });

  it("reads each L0 run as a source of its own and the L1 runs it overlaps as one, newest first", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "c", "d"), run("l1/c.sst", 100, "e", "z")];
    const plan = merge(planCompaction(manifest([...l0(4), ...l1]), NOW, limits));
    expect(plan?.sources.map((s) => s.map((r) => r.path))).toEqual([
      ...l0(4).map((r) => [r.path]),
      ["l1/b.sst", "l1/c.sst"],
    ]);
    expect(paths(plan)).toEqual(plan?.sources.flat().map((r) => r.path));
  });

  it.each([49, 17])("takes the oldest L0 runs, so a step reads at most %i sources", (maxSources) => {
    const runs = [...l0(53), run("l1/a.sst", 100, "a", "z")];
    const plan = merge(planCompaction(manifest(runs), NOW, { maxSources }))!;
    const taken = maxSources - 1;
    expect(plan.sources).toHaveLength(maxSources);
    expect(plan.sources.slice(0, taken).map((s) => s.map((r) => r.path))).toEqual(l0(53).slice(53 - taken).map((r) => [r.path]));
    expect(plan.sources[taken]!.map((r) => r.path)).toEqual(["l1/a.sst"]);
    // The newest stay in L0, in front of the step's output.
    const after = replaceRuns(runs, paths(plan)!, [run("l1/c9.0.sst", 100, "a", "z")]);
    expect(after.map((r) => r.path)).toEqual([...l0(53 - taken).map((r) => r.path), "l1/c9.0.sst"]);
  });

  it("reads the pushed run as one source and the runs it overlaps below as another", () => {
    const runs = [run("l1/a.sst", 1500, "a", "f"), run("l2/a.sst", 100, "a", "c"), run("l2/b.sst", 100, "d", "e"), run("l2/c.sst", 100, "x", "z")];
    expect(merge(planCompaction(manifest(runs), NOW, { ...limits, l1Target: 1000 }))?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"], ["l2/a.sst", "l2/b.sst"]]);
    expect(merge(planCompaction(manifest([run("l1/a.sst", 1500, "a", "f")]), NOW, { ...limits, l1Target: 1000 }))?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"]]);
  });

  it("compacts the level furthest over its target first", () => {
    const l1 = [run("l1/a.sst", 1500, "a", "b"), run("l1/b.sst", 1500, "c", "f")];
    expect(merge(planCompaction(manifest([...l0(4), ...l1]), NOW, { ...limits, l1Target: 1000 }))?.outputLevel).toBe(2);
    expect(merge(planCompaction(manifest([...l0(16), ...l1]), NOW, { ...limits, l1Target: 1000 }))?.outputLevel).toBe(1);
  });

  describe("once the levels are in shape, rewrites a run that has not absorbed a mark over it", () => {
    // A range delete over [m, n) at seq 7.
    const marks = markTable({ start: enc.encode("m"), endExclusive: enc.encode("n"), through: 6, at: 7 });
    const at = (r: RunMeta, marksThrough: number): RunMeta => ({ ...r, marksThrough });
    const raw = (runs: RunMeta[]) => planCompaction({ runs, marks }, NOW, limits);
    const plan = (runs: RunMeta[]) => merge(raw(runs));

    it("rewrites a level's run in place", () => {
      const runs = [at(run("l1/a.sst", 100, "a", "f"), 0), at(run("l2/a.sst", 100, "a", "c"), 0), at(run("l2/b.sst", 100, "k", "p"), 6)];
      const step = plan(runs);
      expect(step?.sources.map((s) => s.map((r) => r.path))).toEqual([["l2/b.sst"]]);
      expect(step?.outputLevel).toBe(2);
      expect(step?.bottom).toBe(true);
    });

    it("leaves a run that absorbed the mark or does not reach it", () => {
      expect(plan([at(run("l2/b.sst", 100, "k", "p"), 7), at(run("l2/c.sst", 100, "n", "p"), 0), at(run("l1/a.sst", 100, "a", "lz"), 0)])).toBeUndefined();
      expect(planCompaction({ runs: [at(run("l2/b.sst", 100, "k", "p"), 0)], marks: NO_MARKS }, NOW, limits)).toBeUndefined();
    });

    it("takes the L0 step for an L0 run, however few", () => {
      const step = plan([at(run("l0/2.sst", 100, "x", "z"), 7), at(run("l0/1.sst", 100, "l", "m"), 5), at(run("l1/a.sst", 100, "a", "z"), 7)]);
      expect(paths(step)).toEqual(["l0/2.sst", "l0/1.sst", "l1/a.sst"]);
      expect(step?.outputLevel).toBe(1);
    });

    it("comes after a level over its target", () => {
      const runs = [at(run("l1/a.sst", 1500, "a", "f"), 7), at(run("l2/b.sst", 100, "k", "p"), 0)];
      expect(merge(planCompaction({ runs, marks }, NOW, { ...limits, l1Target: 1000 }))?.outputLevel).toBe(2);
      expect(paths(merge(planCompaction({ runs, marks }, NOW, { ...limits, l1Target: 1000 })))).toEqual(["l1/a.sst"]);
    });
  });
});

describe("planCompaction on dead rows", () => {
  const limits = { maxSources: 49 };
  /** Entries `<prefix>00` to `<prefix><n-1>`, with seqs from `seq` up. */
  const rows = (prefix: string, n: number, seq: number, kind: "put" | "del" | number = "put"): SstEntry[] =>
    Array.from({ length: n }, (_, i): SstEntry => {
      const key = enc.encode(`${prefix}${String(i).padStart(2, "0")}`);
      if (kind === "del") return { kind: "del", key, seq: seq + i };
      const value = new Uint8Array(20);
      return kind === "put" ? { kind: "put", key, value, seq: seq + i } : { kind: "put", key, value, seq: seq + i, expiresAt: kind };
    });
  const at = (path: string, entries: SstEntry[], marksThrough = 0) => listedRun(path, 1000, entries, marksThrough);

  it("drops a run a mark wholly covers, without a merge", () => {
    const marks = markTable({ start: enc.encode("k"), endExclusive: enc.encode("l"), through: 20, at: 21 });
    const covered = at("l2/b.sst", rows("k", 10, 11));
    const runs = [at("l2/a.sst", rows("a", 10, 1)), covered, at("l2/c.sst", rows("x", 10, 1))];
    expect(planCompaction({ runs, marks }, NOW, limits)).toEqual({ kind: "drop", inputs: [covered] });
  });

  it("rewrites, and does not drop, a run with a version written past the mark", () => {
    const marks = markTable({ start: enc.encode("k"), endExclusive: enc.encode("l"), through: 19, at: 21 });
    const plan = planCompaction({ runs: [at("l2/b.sst", rows("k", 10, 11))], marks }, NOW, limits);
    expect(plan?.kind).toBe("merge");
    expect(paths(plan)).toEqual(["l2/b.sst"]);
  });

  it("rewrites a half-expired bottom run alone, and leaves it before its rows expire", () => {
    const runs = [at("l1/a.sst", rows("a", 10, 1)), at("l2/a.sst", [...rows("b", 6, 1, 500), ...rows("c", 4, 7)])];
    expect(planCompaction({ runs, marks: NO_MARKS }, 499, limits)).toBeUndefined();
    const plan = merge(planCompaction({ runs, marks: NO_MARKS }, 500, limits));
    expect(plan?.sources.map((s) => s.map((r) => r.path))).toEqual([["l2/a.sst"]]);
    expect(plan?.bottom).toBe(true);
  });

  it("leaves a run under half dead", () => {
    const runs = [at("l2/a.sst", [...rows("b", 4, 1, 500), ...rows("c", 6, 7)])];
    expect(planCompaction({ runs, marks: NO_MARKS }, NOW, limits)).toBeUndefined();
  });

  it("rewrites a half-tombstone bottom run alone, so its tombstones drop", () => {
    const runs = [at("l1/a.sst", [...rows("b", 6, 1, "del"), ...rows("c", 4, 7)]), at("l2/a.sst", rows("x", 10, 1))];
    const plan = merge(planCompaction({ runs, marks: NO_MARKS }, NOW, limits));
    expect(paths(plan)).toEqual(["l1/a.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(plan?.bottom).toBe(true);
  });

  it("pushes a half-tombstone run that still hides versions below down with the runs it overlaps", () => {
    const runs = [
      at("l1/a.sst", [...rows("b", 6, 21, "del"), ...rows("c", 4, 27)]),
      at("l2/a.sst", rows("b", 10, 1)),
      at("l2/b.sst", rows("x", 10, 11)),
      at("l3/a.sst", rows("b", 10, 1)),
    ];
    const plan = merge(planCompaction({ runs, marks: NO_MARKS }, NOW, limits));
    expect(plan?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"], ["l2/a.sst"]]);
    expect(plan?.outputLevel).toBe(2);
    expect(plan?.bottom).toBe(false);
  });

  it("takes the L0 step for a half-expired L0 run, and leaves a lone L0 run of tombstones for it", () => {
    const l1 = at("l1/a.sst", rows("b", 10, 1));
    const plan = merge(planCompaction({ runs: [at("l0/1.sst", rows("b", 10, 11, 500)), l1], marks: NO_MARKS }, 500, limits));
    expect(paths(plan)).toEqual(["l0/1.sst", "l1/a.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(planCompaction({ runs: [at("l0/1.sst", rows("b", 10, 11, "del")), l1], marks: NO_MARKS }, NOW, limits)).toBeUndefined();
  });

  it("does level-shape work first", () => {
    const runs = [at("l1/a.sst", rows("a", 10, 1)), at("l1/b.sst", rows("b", 10, 11)), at("l2/a.sst", rows("x", 10, 1, "del"))];
    const plan = merge(planCompaction({ runs: [{ ...runs[0]!, bytes: 1500 }, ...runs.slice(1)], marks: NO_MARKS }, NOW, { ...limits, l1Target: 1000 }));
    expect(plan?.outputLevel).toBe(2);
    expect(paths(plan)).not.toContain("l2/a.sst");
  });

  it("rewrites the run a mark covers most first", () => {
    const marks = markTable({ start: enc.encode("b05"), endExclusive: enc.encode("c"), through: 100, at: 101 });
    const little = at("l2/a.sst", rows("a", 10, 1).concat(rows("b0", 1, 11)));
    const much = at("l2/b.sst", [...rows("b1", 3, 12), ...rows("x", 7, 15)]);
    expect(paths(planCompaction({ runs: [little, much], marks }, NOW, limits))).toEqual(["l2/b.sst"]);
  });
});

describe("replaceRuns", () => {
  it("keeps L0 order, then sorts each level by key", () => {
    const runs = [run("l0/2.sst", 1, "a", "z"), run("l0/1.sst", 1, "a", "z"), run("l1/b.sst", 1, "m", "n"), run("l2/a.sst", 1, "a", "b")];
    const out = replaceRuns(runs, ["l0/1.sst"], [run("l1/a.sst", 1, "c", "d"), run("l1/c.sst", 1, "x", "y")]);
    expect(out.map((r) => r.path)).toEqual(["l0/2.sst", "l1/a.sst", "l1/b.sst", "l1/c.sst", "l2/a.sst"]);
  });
});

const NAME = "levels";

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe("bottom compaction", () => {
  beforeEach(async () => {
    __resetMemoryFsForTests(NAME);
    await wipe();
  });
  afterEach(() => __resetMemoryFsForTests(NAME));

  it("leaves no tombstone on disk and deleted keys stay deleted", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({
      name: NAME,
      fs,
      forceMemory: true,
      maxWalBytes: 2 ** 40,
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.put(enc.encode("b"), enc.encode("1"));
    await ingest(db);
    for (let i = 0; i < 3; i++) {
      await db.delete(enc.encode("a"));
      await ingest(db);
    }
    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs).toHaveLength(1);
    const file = (await fs.read(runs[0]!.path, 0, 1 << 30))!;
    expect(runs[0]!.bytes).toBe(file.byteLength);
    const entries = decodeSst(file);
    expect(entries.map((e) => e.kind)).toEqual(["put"]);
    expect(await db.get(enc.encode("a"))).toBeUndefined();
    expect(new TextDecoder().decode((await db.get(enc.encode("b")))!)).toBe("1");
    await db.close();
  });
});
