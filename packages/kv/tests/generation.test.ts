import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryFs
} from "../src/index.js";
import {
  __resetMemoryFsForTests
} from "../src/testing.js";
import {
  decodeGeneration,
  encodeGeneration,
  loadLatestGeneration,
  publishGeneration,
} from "../src/store/generation.js";

const NAME = "generation-coherence";
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

function mft(generation: number): string {
  return `m/${String(generation).padStart(16, "0")}.mft`;
}

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

afterEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

describe("manifest", () => {
  it("round-trips each run's key range", () => {
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", range: { smallest: utf("a"), largest: utf("m") } },
        { path: "l1/c2.0-10.sst" },
      ],
      tombstoneSeq: 4,
    };
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });
});

describe("loadLatestGeneration", () => {
  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0 });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0 });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0 });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0 });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });

  it("returns the newest manifest when it is larger than 1 MiB", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0 });
    const key = (c: number) => new Uint8Array(8 * 1024).fill(c);
    const runs = Array.from({ length: 100 }, (_, i) => ({
      path: `l1/r${i}-4194304.sst`,
      range: { smallest: key(i * 2), largest: key(i * 2 + 1) },
    }));
    await publishGeneration(fs, { generation: 2, runs, tombstoneSeq: 0 });
    const meta = await loadLatestGeneration(fs);
    expect(meta?.generation).toBe(2);
    expect(meta?.runs).toHaveLength(100);
  });
});
