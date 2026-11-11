import { afterEach, describe, expect, it } from "vitest";
import type { HostBudget } from "../src/host/budget.js";
import {
  encodeSst,
  engineMemory,
  engineUsingWasm,
  ensureEngine,
  openMerge,
  recycleEngine,
  type MergeSpec,
} from "../src/store/engine.js";
import { settle as settleRead } from "../src/store/cursor.js";
import {
  __resetMemoryFsForTests,
  openHarnessDb,
  readStats,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../src/testing.js";
import { drain, readerOfBytes } from "./runs.js";

const MiB = 1024 * 1024;
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const dec = new TextDecoder();

/** A run whose one value is 3 MiB from a few KiB packed, so decoding it grows the instance that does. */
const bigRun = (codec: "raw" | "lz4") =>
  encodeSst([{ kind: "put", key: utf("big"), value: new Uint8Array(3 * MiB).fill(7), seq: 1 }], codec);

describe("recycleEngine", () => {
  it("replaces an instance past the threshold with a fresh one", async () => {
    await ensureEngine();
    expect(engineUsingWasm()).toBe(true);
    await bigRun("raw");
    const grown = engineMemory();
    expect(grown.wasmBytes).toBeGreaterThan(4 * MiB);

    expect(recycleEngine(grown.wasmBytes - 1)).toBe(true);

    const after = engineMemory();
    expect(after.wasmBytes).toBeLessThan(2 * MiB);
    expect(after.wasmPeakBytes).toBeGreaterThanOrEqual(grown.wasmBytes);
    expect(after.recycles).toBe(grown.recycles + 1);
  });

  it("leaves an instance at or under the threshold alone", async () => {
    await ensureEngine();
    const { wasmBytes, recycles } = engineMemory();

    expect(recycleEngine(wasmBytes)).toBe(false);

    expect(engineMemory()).toMatchObject({ wasmBytes, recycles });
  });

  describe("with a merge session", () => {
    const spec: MergeSpec = {
      sources: [[1000]],
      dropTombstones: false,
      targetBytes: 4 * MiB,
      codec: "raw",
      chunkBytes: 64 * 1024,
      tailBytes: 64 * 1024,
      yieldBytes: MiB,
    };

    it("waits for the session to close, since it lives in the instance", async () => {
      await ensureEngine();
      await bigRun("raw");
      const { recycles } = engineMemory();
      const session = await openMerge(spec);

      expect(recycleEngine(0)).toBe(false);
      expect(engineMemory().recycles).toBe(recycles);

      session.close();
      expect(recycleEngine(0)).toBe(true);
      expect(engineMemory().recycles).toBe(recycles + 1);
    });

    it("reports the most a session was asked to reserve: a window per source and one for the output", async () => {
      await ensureEngine();
      const wide: MergeSpec = { ...spec, sources: Array.from({ length: 9 }, () => [1000]), chunkBytes: MiB };

      (await openMerge(wide)).close();
      (await openMerge(spec)).close();

      expect(engineMemory().mergeReservedBytes).toBeGreaterThanOrEqual(10 * MiB);
    });
  });

  it("keeps the lz4 decoder and the block scanner on the current instance", async () => {
    await ensureEngine();
    const run = await bigRun("lz4");

    recycleEngine(0);
    const freshForGet = engineMemory().wasmBytes;
    const reader = readerOfBytes(run);
    const hit = await settleRead(() => reader.get(utf("big")));
    expect(hit?.kind === "put" && hit.value.byteLength).toBe(3 * MiB);
    // The 3 MiB it unpacked went into the new instance. A hook that kept the old one would leave this at its fresh size.
    expect(engineMemory().wasmBytes).toBeGreaterThan(freshForGet + 2 * MiB);

    recycleEngine(0);
    const freshForScan = engineMemory().wasmBytes;
    const hits = await drain(readerOfBytes(run).scanContains([new Uint8Array([7, 7, 7])]));
    expect(hits.map((h) => dec.decode(h.key))).toEqual(["big"]);
    expect(engineMemory().wasmBytes).toBeGreaterThan(freshForScan + 2 * MiB);
  });
});

describe("the host's recycle points", () => {
  const NAME = "engine-recycle";

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    __resetMemoryFsForTests(NAME);
  });

  /**
   * `rounds` flushes of `perFlush` puts of 40,000 bytes on a fresh instance, each followed by the
   * compaction it triggers. Nothing runs after the last `ingest`, so the instance is as the last
   * recycle point left it.
   */
  async function workload(overrides: Partial<HostBudget>, perFlush: number, rounds: number) {
    await ensureEngine();
    recycleEngine(0);
    const recyclesBefore = engineMemory().recycles;
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs, overrides);
    const db = await openHarnessDb({
      name: NAME,
      writerId: "w1",
      fs,
      ingest: createLocalIngestClient(host),
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < perFlush; i++) await db.put(utf(`k${round}-${i}`), new Uint8Array(40_000));
      await ingest(db);
    }
    const { host: stats } = await readStats(db);
    await db.close();
    return { stats, recycled: stats.memory.recycles - recyclesBefore };
  }

  it("recycles after a flush chunk that grew the instance past the threshold", async () => {
    // One backlog of three chunks, one run short of a compaction. The pass after a fold would
    // recycle once, so only a recycle between chunks makes it more than one.
    const kept = await workload({ flushRunBytes: MiB, wasmRecycleBytes: Number.POSITIVE_INFINITY }, 60, 1);
    const recycled = await workload({ flushRunBytes: MiB, wasmRecycleBytes: 3 * MiB }, 60, 1);

    expect(recycled.stats.flushes).toBe(3);
    expect(recycled.stats.compactionSteps).toBe(0);
    expect(kept.recycled).toBe(0);
    expect(kept.stats.memory.wasmBytes).toBeGreaterThan(3 * MiB);
    expect(recycled.recycled).toBeGreaterThanOrEqual(2);
    expect(recycled.stats.memory.wasmBytes).toBeLessThanOrEqual(3 * MiB);
    expect(recycled.stats.memory.wasmPeakBytes).toBeGreaterThan(3 * MiB);
  });

  it("recycles after a compaction step that grew the instance past the threshold", async () => {
    // Flushes of one put stay under the threshold. The step reserves a 4 MiB output buffer.
    const budget = { chunkBytes: 4 * MiB };
    const kept = await workload({ ...budget, wasmRecycleBytes: Number.POSITIVE_INFINITY }, 1, 4);
    const recycled = await workload({ ...budget, wasmRecycleBytes: 3 * MiB }, 1, 4);

    expect(kept.stats.compactionSteps).toBeGreaterThanOrEqual(1);
    expect(kept.recycled).toBe(0);
    expect(kept.stats.memory.wasmBytes).toBeGreaterThan(3 * MiB);
    expect(recycled.stats.compactionSteps).toBeGreaterThanOrEqual(1);
    expect(recycled.recycled).toBeGreaterThan(0);
    expect(recycled.stats.memory.wasmBytes).toBeLessThanOrEqual(3 * MiB);
    expect(recycled.stats.memory.mergeReservedBytes).toBeGreaterThanOrEqual(2 * 4 * MiB);
  });
});
