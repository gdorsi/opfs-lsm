import { afterEach, describe, expect, it } from "vitest";
import { Host, MemoryFs, openHarnessDb, readStats, settle, __resetMemoryFsForTests } from "../src/testing.js";
import { CountingFs } from "../src/opfs/counting-fs.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { levelOf } from "../src/store/levels.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const NAME = "stats-db";

afterEach(() => __resetMemoryFsForTests(NAME));

async function write(fs: CountingFs, path: string, bytes: number): Promise<void> {
  const w = await fs.create(path);
  await w.write(new Uint8Array(bytes));
  await w.finish();
}

describe("CountingFs", () => {
  it("attributes IO by the first path segment", async () => {
    const fs = new CountingFs(new MemoryFs());
    await write(fs, "l0/a.sst", 10);
    await write(fs, "l2/run.sst", 7);
    await write(fs, "m/0000000000000001.mft", 3);
    await write(fs, "top.bin", 2);
    await write(fs, "lx/x", 1);

    const aborted = await fs.create("l1/gone.sst");
    await aborted.write(new Uint8Array(5));
    await aborted.abort();

    await fs.read("l0/a.sst", 0, 4);
    await fs.read("l0/a.sst", 0, Number.POSITIVE_INFINITY);
    await fs.read("l9/missing", 0, 1);

    await fs.remove("l0/a.sst");
    await fs.remove("l3/other.sst");
    await fs.remove("m/unknown.mft");

    expect(fs.counters.written).toEqual({
      l0: { calls: 1, bytes: 10 },
      l2: { calls: 1, bytes: 7 },
      m: { calls: 1, bytes: 3 },
      other: { calls: 2, bytes: 3 },
    });
    expect(fs.counters.read).toEqual({
      l0: { calls: 2, bytes: 14 },
      l9: { calls: 1, bytes: 0 },
    });
    expect(fs.counters.removed).toEqual({
      // Size remembered from finish.
      l0: { calls: 1, bytes: 10 },
      // Not finished by this fs, so no size.
      l3: { calls: 1, bytes: 0 },
      m: { calls: 1, bytes: 0 },
    });
  });
});

describe("readStats", () => {
  it("counts appends, flushes, compaction and layout", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs, host: new Host(() => fs) });

    let folded = 0;
    for (let i = 0; i < 4; i++) {
      const key = utf(`key-${i}`);
      const value = utf(`value-${i}`.repeat(i + 1));
      folded += key.byteLength + value.byteLength;
      await db.put(key, value);
      await db.ingest();
    }
    await settle(db);

    const stats = await readStats(db);
    expect(stats.tab.appends).toBe(4);
    expect(stats.tab.appendBytes).toBe(folded);
    expect(stats.host.flushes).toBe(4);
    expect(stats.host.foldedBytes).toBeGreaterThanOrEqual(folded);
    expect(stats.host.fs.written.l0!.calls).toBe(4);
    expect(stats.host.fs.written.l0!.bytes).toBeGreaterThan(0);
    expect(stats.host.fs.written.l1!.bytes).toBeGreaterThan(0);
    expect(stats.host.fs.written.m!.calls).toBeGreaterThanOrEqual(5);
    expect(stats.host.fs.read.l0!.calls).toBeGreaterThanOrEqual(4);
    expect(stats.host.compactionSteps).toBeGreaterThanOrEqual(1);
    // The host writes runs and manifests, the tab only its log segments, which are no AsyncFs file.
    expect(stats.tab.fs.written).toEqual({});

    const latest = (await loadLatestGeneration(fs))!;
    expect(stats.host.generation).toBe(latest.generation);
    const runsByLevel = new Map<number, number>();
    for (const run of latest.runs) {
      const level = levelOf(run.path)!;
      runsByLevel.set(level, (runsByLevel.get(level) ?? 0) + 1);
    }
    expect(stats.host.layout.map((l) => [l.level, l.runs])).toEqual(
      [...runsByLevel].sort((a, b) => a[0] - b[0]),
    );
    expect(stats.host.layout.every((l) => l.bytes > 0)).toBe(true);
    expect(stats.host.layout.find((l) => l.level === 1)!.bytes).toBe(
      stats.host.fs.written.l1!.bytes - (stats.host.fs.removed.l1?.bytes ?? 0),
    );

    // Snapshots: later IO does not change an earlier result.
    const before = stats.host.fs.written.l0!.calls;
    await db.put(utf("late"), utf("x"));
    await db.ingest();
    expect(stats.host.fs.written.l0!.calls).toBe(before);
    expect((await readStats(db)).host.fs.written.l0!.calls).toBe(before + 1);
    await db.close();
  });

  it("settle reaches a generation that further ingests leave alone", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs, host: new Host(() => fs) });
    for (let i = 0; i < 9; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.sync();
    }
    await settle(db);
    const settled = (await readStats(db)).host;
    expect((await db.ingest()).generation).toBe(settled.generation);
    expect((await readStats(db)).host.compactionSteps).toBe(settled.compactionSteps);
    await db.close();
  });

  it("a first ingest on a new database is one L0 run in generation 1", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs, host: new Host(() => fs) });
    const key = utf("k");
    const value = utf("v");
    await db.put(key, value);
    await db.ingest();

    const stats = await readStats(db);
    expect(stats.tab.appends).toBe(1);
    expect(stats.tab.appendBytes).toBe(key.byteLength + value.byteLength);
    expect(stats.host.flushes).toBe(1);
    expect(stats.host.generation).toBe(1);
    expect(stats.host.fs.written.l0!.calls).toBe(1);
    expect(stats.host.layout).toEqual([{ level: 0, runs: 1, bytes: stats.host.fs.written.l0!.bytes }]);
    await db.close();
  });

  it("rejects a Db it did not open", async () => {
    await expect(readStats({} as never)).rejects.toThrow(/not opened/);
  });
});
