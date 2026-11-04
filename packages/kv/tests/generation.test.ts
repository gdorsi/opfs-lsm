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
    await publishGeneration(fs, 1, ["l0/a.sst"]);
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: ["l0/a.sst"] });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, 1, ["l0/a.sst"]);
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: ["l0/a.sst"] });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });
});

describe("installed generation", () => {
  it("keeps a newer generation when an older load finishes later", async () => {
    const inner = new MemoryFs();
    const key = enc.encode("k");
    const older = await publishL0(inner, "g1", [
      { kind: "put", key, value: enc.encode("old") },
    ]);
    await publishGeneration(inner, 1, [older]);

    const gate = holdFirstL0(inner);
    const db = await openDb({
      name: NAME,
      writerId: "w1",
      fs: gate,
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });

    const pending = db.get(key);
    await gate.started;

    const newer = await publishL0(inner, "g2", [
      { kind: "put", key, value: enc.encode("new") },
    ]);
    await publishGeneration(inner, 2, [newer]);
    const wal = await IdBWal.open(checkDbName(NAME));
    await wal.raiseGeneration(2);
    wal.close();
    expect(dec.decode((await db.get(key))!)).toBe("new");

    gate.release();

    expect(dec.decode((await pending)!)).toBe("new");
    expect(dec.decode((await db.get(key))!)).toBe("new");
    await db.close();
  });
});
