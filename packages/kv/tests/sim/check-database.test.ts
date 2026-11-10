import { describe, expect, it } from "vitest";
import { MemoryFs } from "../../src/index.js";
import { loadGeneration, publishGeneration } from "../../src/store/generation.js";
import { Host, openHarnessDb } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "check-db";

/** A host that ingests only when a page asks, so a closed page's tail stays in its log. */
const quietHost = (fs: MemoryFs) => new Host(() => fs, { maxLatencyMs: 1e9 });

/** Five ingests so one compaction ran, then a tail left in the closed page's log. */
async function seeded() {
  const fs = new MemoryFs();
  const host = quietHost(fs);
  const db = await openHarnessDb({ name: NAME, fs, host });
  for (let i = 0; i < 5; i++) {
    await db.put(utf(`k${i}`), utf(`v${i}`));
    await db.put(utf(`k${i + 1}`), utf(`w${i}`));
    if (i === 2) await db.delete(utf("k0"));
    await db.ingest();
  }
  await db.put(utf("tail"), utf("t"));
  await db.close();
  return { fs, host };
}

async function newest(fs: MemoryFs) {
  const { generation } = await checkDatabase(fs);
  return (await loadGeneration(fs, generation))!;
}

describe("checkDatabase", () => {
  it("passes a healthy database and folds its runs", async () => {
    const { fs } = await seeded();
    const report = await checkDatabase(fs);
    expect(report.problems).toEqual([]);
    expect(report.through).toBe(11);
    expect(report.pending, "the tail is in its log, not ingested").toBe(1);
    expect(report.logs).toHaveLength(1);
    expect(report.runs.some((p) => p.startsWith("l1/"))).toBe(true);
    expect(report.state.map((e) => new TextDecoder().decode(e.key))).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(report.orphans).toEqual([]);
  });

  it("reports a run whose bytes changed", async () => {
    const { fs } = await seeded();
    const path = (await newest(fs)).runs[0]!.path;
    const bytes = (await fs.read(path, 0, Infinity))!;
    bytes[0] = bytes[0]! ^ 0xff;
    const w = await fs.create(path);
    await w.write(bytes);
    await w.finish();
    expect((await checkDatabase(fs)).problems.join("\n")).toMatch(new RegExp(`${path}.*crc`));
  });

  it("reports a listed run that is gone", async () => {
    const { fs } = await seeded();
    await fs.remove((await newest(fs)).runs[0]!.path);
    expect((await checkDatabase(fs)).problems.join("\n")).toMatch(/missing/);
  });

  it("reports L0 runs listed oldest first", async () => {
    const { fs, host } = await seeded();
    // The open ingests the tail into one L0 run; one more write and ingest make a second.
    const db = await openHarnessDb({ name: NAME, fs, host });
    await db.put(utf("k5"), utf("newest"));
    await db.ingest();
    await db.close();
    const m = await newest(fs);
    const l0 = m.runs.filter((r) => r.path.startsWith("l0/"));
    expect(l0.length).toBeGreaterThanOrEqual(2);
    await publishGeneration(fs, { ...m, runs: [l0[1]!, l0[0]!, ...m.runs.filter((r) => r !== l0[0] && r !== l0[1])] });
    expect((await checkDatabase(fs)).problems.join("\n")).toMatch(/L0 .* not newest first/);
  });

  it("reports overlapping runs in one level", async () => {
    const { fs } = await seeded();
    const m = await newest(fs);
    const l1 = m.runs.find((r) => r.path.startsWith("l1/"))!;
    await publishGeneration(fs, { ...m, runs: [...m.runs, l1] });
    expect((await checkDatabase(fs)).problems.join("\n")).toMatch(/L1 runs overlap/);
  });

  it("reports a manifest whose through is below an older one's", async () => {
    const { fs } = await seeded();
    const m = await newest(fs);
    await publishGeneration(fs, { ...m, generation: m.generation + 1, through: m.through - 1 });
    expect((await checkDatabase(fs)).problems.join("\n")).toMatch(/below an older manifest's/);
  });

  it("counts files no manifest lists as orphans, not problems", async () => {
    const { fs } = await seeded();
    const w = await fs.create("l0/99-99.sst");
    await w.write(utf("junk"));
    await w.finish();
    const report = await checkDatabase(fs);
    expect(report.problems).toEqual([]);
    expect(report.orphans).toEqual(["l0/99-99.sst"]);
  });
});
