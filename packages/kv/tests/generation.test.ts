import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryFs,
  __resetMemoryFsForTests,
  openDb,
} from "../src/index.js";
import { checkDbName } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishL0,
} from "../src/store/generation.js";

const NAME = "generation-coherence";
const enc = new TextEncoder();
const dec = new TextDecoder();

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

function holdFirstL0(inner: MemoryFs): AsyncFs & {
  started: Promise<void>;
  release(): void;
} {
  let hold = true;
  let releaseHold!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    release: () => releaseHold(),
    async read(path, offset, length) {
      if (hold && path.startsWith("l0/")) {
        hold = false;
        markStarted();
        await held;
      }
      return inner.read(path, offset, length);
    },
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    create: (path) => inner.create(path),
  };
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

describe("loadLatestGeneration", () => {
  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: ["l0/a.sst"], tombstoneSeq: 0 });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: ["l0/a.sst"], tombstoneSeq: 0 });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: ["l0/a.sst"], tombstoneSeq: 0 });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: ["l0/a.sst"], tombstoneSeq: 0 });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });
});
