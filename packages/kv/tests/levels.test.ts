import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs, __resetMemoryFsForTests, decodeSst, openDb } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { planCompaction } from "../src/store/levels.js";

describe("planCompaction", () => {
  const l0 = (n: number) => Array.from({ length: n }, (_, i) => `l0/${10 - i}.sst`);

  it("leaves fewer than four L0 runs alone", () => {
    expect(planCompaction([...l0(3), "l1/c1-100.sst"])).toBeUndefined();
  });

  it("merges four L0 runs with L1 into L1, at the bottom when nothing is older", () => {
    expect(planCompaction([...l0(4), "l1/c1-100.sst"])).toEqual({
      inputs: [...l0(4), "l1/c1-100.sst"],
      outputLevel: 1,
      bottom: true,
    });
    expect(planCompaction([...l0(4), "l1/c1-100.sst", "l2/c0-900.sst"])?.bottom).toBe(false);
  });

  it("pushes an oversized level into the next one", () => {
    expect(planCompaction(["l1/c5-2000.sst", "l2/c3-9000.sst"], 1000)).toEqual({
      inputs: ["l1/c5-2000.sst", "l2/c3-9000.sst"],
      outputLevel: 2,
      bottom: true,
    });
    expect(planCompaction(["l1/c5-900.sst", "l2/c3-9000.sst"], 1000)).toBeUndefined();
  });

  it("folds runs from before levels into the deepest level", () => {
    expect(planCompaction(["l0/9.sst", "l1/c5-10.sst", "sst/c2-4.sst"])).toEqual({
      inputs: ["l1/c5-10.sst", "sst/c2-4.sst"],
      outputLevel: 1,
      bottom: true,
    });
  });
});

const NAME = "levels";
const enc = new TextEncoder();

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
    const db = await openDb({
      name: NAME,
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 1e9, maxBytes: 2 ** 40 },
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
    const entries = await decodeSst((await fs.read(runs[0]!, 0, 1 << 30))!);
    expect(entries.map((e) => e.kind)).toEqual(["put"]);
    expect(await db.get(enc.encode("a"))).toBeUndefined();
    expect(new TextDecoder().decode((await db.get(enc.encode("b")))!)).toBe("1");
    await db.close();
  });
});
