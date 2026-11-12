import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests, ingest, MemoryFs } from "../src/testing.js";
import { loadLatestGeneration, type RunMeta } from "../src/store/generation.js";
import { planCompaction, replaceRuns, type CompactionPlan } from "../src/store/levels.js";
import { markTable, NO_MARKS } from "../src/store/marks.js";
import { decodeSst } from "../src/store/sst.js";

const enc = new TextEncoder();

const run = (path: string, bytes: number, smallest?: string, largest?: string): RunMeta =>
  smallest === undefined
    ? { path, bytes, marksThrough: 0 }
    : { path, bytes, range: { smallest: enc.encode(smallest), largest: enc.encode(largest ?? smallest) }, marksThrough: 0 };
const manifest = (runs: readonly RunMeta[], marks = NO_MARKS) => ({ runs, marks });
const paths = (plan: CompactionPlan | undefined) => plan?.inputs.map((r) => r.path);

describe("planCompaction", () => {
  const l0 = (n: number) => Array.from({ length: n }, (_, i) => run(`l0/${10 - i}.sst`, 100, "c", "f"));
  const limits = { maxSources: 49 };

  it("leaves fewer than four L0 runs alone", () => {
    expect(planCompaction(manifest([...l0(3), run("l1/c1.sst", 100, "a", "z")]), limits)).toBeUndefined();
  });

  it("merges four L0 runs with only the L1 runs they overlap", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "d", "e"), run("l1/c.sst", 100, "x", "z")];
    const plan = planCompaction(manifest([...l0(4), ...l1]), limits);
    expect(paths(plan)).toEqual([...l0(4).map((r) => r.path), "l1/b.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(plan?.bottom).toBe(true);
  });

  it("is a bottom merge only when no deeper run overlaps the inputs", () => {
    const l1 = run("l1/a.sst", 100, "c", "d");
    expect(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900, "x", "z")]), limits)?.bottom).toBe(true);
    expect(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900, "e", "g")]), limits)?.bottom).toBe(false);
    expect(planCompaction(manifest([...l0(4), l1, run("l2/a.sst", 900)]), limits)?.bottom).toBe(false);
  });

  it("pushes the oversized level's run with the least overlap below it", () => {
    const runs = [
      run("l1/a.sst", 600, "a", "f"),
      run("l1/b.sst", 600, "g", "m"),
      run("l2/a.sst", 5000, "a", "c"),
      run("l2/b.sst", 100, "h", "i"),
      run("l2/c.sst", 100, "j", "k"),
    ];
    const plan = planCompaction(manifest(runs), { ...limits, l1Target: 1000 });
    expect(paths(plan)).toEqual(["l1/b.sst", "l2/b.sst", "l2/c.sst"]);
    expect(plan?.outputLevel).toBe(2);
    expect(planCompaction(manifest(runs.slice(1)), { ...limits, l1Target: 1000 })).toBeUndefined();
  });

  it("reads each L0 run as a source of its own and the L1 runs it overlaps as one, newest first", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "c", "d"), run("l1/c.sst", 100, "e", "z")];
    const plan = planCompaction(manifest([...l0(4), ...l1]), limits);
    expect(plan?.sources.map((s) => s.map((r) => r.path))).toEqual([
      ...l0(4).map((r) => [r.path]),
      ["l1/b.sst", "l1/c.sst"],
    ]);
    expect(paths(plan)).toEqual(plan?.sources.flat().map((r) => r.path));
  });

  it.each([49, 17])("takes the oldest L0 runs, so a step reads at most %i sources", (maxSources) => {
    const runs = [...l0(53), run("l1/a.sst", 100, "a", "z")];
    const plan = planCompaction(manifest(runs), { maxSources })!;
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
    expect(planCompaction(manifest(runs), { ...limits, l1Target: 1000 })?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"], ["l2/a.sst", "l2/b.sst"]]);
    expect(planCompaction(manifest([run("l1/a.sst", 1500, "a", "f")]), { ...limits, l1Target: 1000 })?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"]]);
  });

  it("compacts the level furthest over its target first", () => {
    const l1 = [run("l1/a.sst", 1500, "a", "b"), run("l1/b.sst", 1500, "c", "f")];
    expect(planCompaction(manifest([...l0(4), ...l1]), { ...limits, l1Target: 1000 })?.outputLevel).toBe(2);
    expect(planCompaction(manifest([...l0(16), ...l1]), { ...limits, l1Target: 1000 })?.outputLevel).toBe(1);
  });

  describe("once the levels are in shape, rewrites a run that holds back a mark", () => {
    // A range delete over [m, n) in the record at seq 7.
    const marks = markTable({ start: enc.encode("m"), endExclusive: enc.encode("n"), through: 6, at: 7 });
    const at = (r: RunMeta, marksThrough: number): RunMeta => ({ ...r, marksThrough });
    const plan = (runs: RunMeta[], l1Target?: number) => planCompaction(manifest(runs, marks), { ...limits, ...(l1Target ? { l1Target } : {}) });

    it("rewrites a level's run alone, in its level", () => {
      const step = plan([at(run("l1/a.sst", 100, "a", "f"), 0), at(run("l2/a.sst", 100, "a", "c"), 0), at(run("l2/b.sst", 100, "k", "p"), 6)]);
      expect(step?.sources.map((s) => s.map((r) => r.path))).toEqual([["l2/b.sst"]]);
      expect(step?.outputLevel).toBe(2);
    });

    it("leaves a run that absorbed the mark or does not reach it", () => {
      expect(plan([at(run("l2/b.sst", 100, "k", "p"), 7), at(run("l2/c.sst", 100, "n", "p"), 0), at(run("l1/a.sst", 100, "a", "lz"), 0)])).toBeUndefined();
      expect(planCompaction(manifest([at(run("l2/b.sst", 100, "k", "p"), 0)]), limits)).toBeUndefined();
    });

    it("takes the L0 step for an L0 run, however few", () => {
      const step = plan([at(run("l0/2.sst", 100, "x", "z"), 7), at(run("l0/1.sst", 100, "m", "m"), 5), at(run("l1/a.sst", 100, "a", "z"), 7)]);
      expect(paths(step)).toEqual(["l0/2.sst", "l0/1.sst", "l1/a.sst"]);
      expect(step?.outputLevel).toBe(1);
    });

    it("comes after a level over its target", () => {
      expect(paths(plan([at(run("l1/a.sst", 1500, "a", "f"), 7), at(run("l2/b.sst", 100, "k", "p"), 0)], 1000))).toEqual(["l1/a.sst"]);
    });

    it("ends: each step's output absorbs every mark, so the next plan is undefined", () => {
      let runs = [at(run("l0/1.sst", 100, "m", "m"), 0), at(run("l1/a.sst", 100, "a", "z"), 0), at(run("l2/a.sst", 100, "l", "q"), 0)];
      let steps = 0;
      for (let step = plan(runs); step; step = plan(runs)) {
        const outputs = step.inputs.length > 0 ? [at(run(`l${step.outputLevel}/c${++steps}.sst`, 100, "a", "z"), 7)] : [];
        runs = replaceRuns(runs, step.inputs.map((r) => r.path), outputs);
        expect(steps).toBeLessThan(10);
      }
      expect(steps).toBe(2);
    });
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
