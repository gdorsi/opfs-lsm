import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryFs,
  decodeSst
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";
import { loadLatestGeneration, type RunMeta } from "../src/store/generation.js";
import { planCompaction, replaceRuns, type CompactionPlan } from "../src/store/levels.js";

const enc = new TextEncoder();

const run = (path: string, bytes: number, smallest?: string, largest?: string): RunMeta =>
  smallest === undefined
    ? { path, bytes }
    : { path, bytes, range: { smallest: enc.encode(smallest), largest: enc.encode(largest ?? smallest) } };
const paths = (plan: CompactionPlan | undefined) => plan?.inputs.map((r) => r.path);

describe("planCompaction", () => {
  const l0 = (n: number) => Array.from({ length: n }, (_, i) => run(`l0/${10 - i}.sst`, 100, "c", "f"));

  it("leaves fewer than four L0 runs alone", () => {
    expect(planCompaction([...l0(3), run("l1/c1.sst", 100, "a", "z")])).toBeUndefined();
  });

  it("merges four L0 runs with only the L1 runs they overlap", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "d", "e"), run("l1/c.sst", 100, "x", "z")];
    const plan = planCompaction([...l0(4), ...l1]);
    expect(paths(plan)).toEqual([...l0(4).map((r) => r.path), "l1/b.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(plan?.bottom).toBe(true);
  });

  it("is a bottom merge only when no deeper run overlaps the inputs", () => {
    const l1 = run("l1/a.sst", 100, "c", "d");
    expect(planCompaction([...l0(4), l1, run("l2/a.sst", 900, "x", "z")])?.bottom).toBe(true);
    expect(planCompaction([...l0(4), l1, run("l2/a.sst", 900, "e", "g")])?.bottom).toBe(false);
    expect(planCompaction([...l0(4), l1, run("l2/a.sst", 900)])?.bottom).toBe(false);
  });

  it("pushes the oversized level's run with the least overlap below it", () => {
    const runs = [
      run("l1/a.sst", 600, "a", "f"),
      run("l1/b.sst", 600, "g", "m"),
      run("l2/a.sst", 5000, "a", "c"),
      run("l2/b.sst", 100, "h", "i"),
      run("l2/c.sst", 100, "j", "k"),
    ];
    const plan = planCompaction(runs, 1000);
    expect(paths(plan)).toEqual(["l1/b.sst", "l2/b.sst", "l2/c.sst"]);
    expect(plan?.outputLevel).toBe(2);
    expect(planCompaction(runs.slice(1), 1000)).toBeUndefined();
  });

  it("reads each L0 run as a source of its own and the L1 runs it overlaps as one, newest first", () => {
    const l1 = [run("l1/a.sst", 100, "a", "b"), run("l1/b.sst", 100, "c", "d"), run("l1/c.sst", 100, "e", "z")];
    const plan = planCompaction([...l0(4), ...l1]);
    expect(plan?.sources.map((s) => s.map((r) => r.path))).toEqual([
      ...l0(4).map((r) => [r.path]),
      ["l1/b.sst", "l1/c.sst"],
    ]);
    expect(paths(plan)).toEqual(plan?.sources.flat().map((r) => r.path));
  });

  it("takes the oldest fifteen L0 runs, so a step reads at most sixteen sources", () => {
    const runs = [...l0(20), run("l1/a.sst", 100, "a", "z")];
    const plan = planCompaction(runs)!;
    expect(plan.sources).toHaveLength(16);
    expect(plan.sources.slice(0, 15).map((s) => s.map((r) => r.path))).toEqual(l0(20).slice(5).map((r) => [r.path]));
    expect(plan.sources[15]!.map((r) => r.path)).toEqual(["l1/a.sst"]);
    // The five newest stay in L0, in front of the step's output.
    const after = replaceRuns(runs, paths(plan)!, [run("l1/c9.0.sst", 100, "a", "z")]);
    expect(after.map((r) => r.path)).toEqual([...l0(5).map((r) => r.path), "l1/c9.0.sst"]);
  });

  it("reads the pushed run as one source and the runs it overlaps below as another", () => {
    const runs = [run("l1/a.sst", 1500, "a", "f"), run("l2/a.sst", 100, "a", "c"), run("l2/b.sst", 100, "d", "e"), run("l2/c.sst", 100, "x", "z")];
    expect(planCompaction(runs, 1000)?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"], ["l2/a.sst", "l2/b.sst"]]);
    expect(planCompaction([run("l1/a.sst", 1500, "a", "f")], 1000)?.sources.map((s) => s.map((r) => r.path))).toEqual([["l1/a.sst"]]);
  });

  it("compacts the level furthest over its target first", () => {
    const l1 = [run("l1/a.sst", 1500, "a", "b"), run("l1/b.sst", 1500, "c", "f")];
    expect(planCompaction([...l0(4), ...l1], 1000)?.outputLevel).toBe(2);
    expect(planCompaction([...l0(16), ...l1], 1000)?.outputLevel).toBe(1);
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
      ingestPolicy: { maxWalBytes: 2 ** 40 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.put(enc.encode("b"), enc.encode("1"));
    await db.ingest();
    for (let i = 0; i < 3; i++) {
      await db.delete(enc.encode("a"));
      await db.ingest();
    }
    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs).toHaveLength(1);
    const file = (await fs.read(runs[0]!.path, 0, 1 << 30))!;
    expect(runs[0]!.bytes).toBe(file.byteLength);
    const entries = await decodeSst(file);
    expect(entries.map((e) => e.kind)).toEqual(["put"]);
    expect(await db.get(enc.encode("a"))).toBeUndefined();
    expect(new TextDecoder().decode((await db.get(enc.encode("b")))!)).toBe("1");
    await db.close();
  });
});
