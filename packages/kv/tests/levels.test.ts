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

const run = (path: string, smallest?: string, largest?: string): RunMeta =>
  smallest === undefined
    ? { path }
    : { path, range: { smallest: enc.encode(smallest), largest: enc.encode(largest ?? smallest) } };
const paths = (plan: CompactionPlan | undefined) => plan?.inputs.map((r) => r.path);

describe("planCompaction", () => {
  const l0 = (n: number) => Array.from({ length: n }, (_, i) => run(`l0/${10 - i}.sst`, "c", "f"));

  it("leaves fewer than four L0 runs alone", () => {
    expect(planCompaction([...l0(3), run("l1/c1-100.sst", "a", "z")])).toBeUndefined();
  });

  it("merges four L0 runs with only the L1 runs they overlap", () => {
    const l1 = [run("l1/a-100.sst", "a", "b"), run("l1/b-100.sst", "d", "e"), run("l1/c-100.sst", "x", "z")];
    const plan = planCompaction([...l0(4), ...l1]);
    expect(paths(plan)).toEqual([...l0(4).map((r) => r.path), "l1/b-100.sst"]);
    expect(plan?.outputLevel).toBe(1);
    expect(plan?.bottom).toBe(true);
  });

  it("is a bottom merge only when no deeper run overlaps the inputs", () => {
    const l1 = run("l1/a-100.sst", "c", "d");
    expect(planCompaction([...l0(4), l1, run("l2/a-900.sst", "x", "z")])?.bottom).toBe(true);
    expect(planCompaction([...l0(4), l1, run("l2/a-900.sst", "e", "g")])?.bottom).toBe(false);
    expect(planCompaction([...l0(4), l1, run("l2/a-900.sst")])?.bottom).toBe(false);
  });

  it("pushes the oversized level's run with the least overlap below it", () => {
    const runs = [
      run("l1/a-600.sst", "a", "f"),
      run("l1/b-600.sst", "g", "m"),
      run("l2/a-5000.sst", "a", "c"),
      run("l2/b-100.sst", "h", "i"),
      run("l2/c-100.sst", "j", "k"),
    ];
    const plan = planCompaction(runs, 1000);
    expect(paths(plan)).toEqual(["l1/b-600.sst", "l2/b-100.sst", "l2/c-100.sst"]);
    expect(plan?.outputLevel).toBe(2);
    expect(planCompaction(runs.slice(1), 1000)).toBeUndefined();
  });
});

describe("replaceRuns", () => {
  it("keeps L0 order, then sorts each level by key", () => {
    const runs = [run("l0/2.sst", "a", "z"), run("l0/1.sst", "a", "z"), run("l1/b-1.sst", "m", "n"), run("l2/a-1.sst", "a", "b")];
    const out = replaceRuns(runs, ["l0/1.sst"], [run("l1/a-1.sst", "c", "d"), run("l1/c-1.sst", "x", "y")]);
    expect(out.map((r) => r.path)).toEqual(["l0/2.sst", "l1/a-1.sst", "l1/b-1.sst", "l1/c-1.sst", "l2/a-1.sst"]);
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
    const entries = await decodeSst((await fs.read(runs[0]!.path, 0, 1 << 30))!);
    expect(entries.map((e) => e.kind)).toEqual(["put"]);
    expect(await db.get(enc.encode("a"))).toBeUndefined();
    expect(new TextDecoder().decode((await db.get(enc.encode("b")))!)).toBe("1");
    await db.close();
  });
});
