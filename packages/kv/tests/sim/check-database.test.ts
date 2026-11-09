import { describe, expect, it } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../../src/index.js";
import { openHarnessDb } from "../../src/testing.js";
import {
  loadGeneration,
  publishGeneration,
} from "../../src/store/generation.js";
import { checkDatabase } from "./check-database.js";

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "check-db";

/** Four flushes so one compaction ran, then a tail left in the log. */
async function seeded() {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const db = await openHarnessDb({
    name: NAME,
    fs,
    ingest: createLocalIngestClient(host),
    ingestPolicy: { maxWalBytes: 1 << 30 },
  });
  for (let i = 0; i < 5; i++) {
    await db.put(utf(`k${i}`), utf(`v${i}`));
    await db.put(utf(`k${i + 1}`), utf(`w${i}`));
    if (i === 2) await db.delete(utf("k0"));
    await db.ingest();
  }
  await db.put(utf("tail"), utf("t"));
  await db.close();
  fsOf = fs;
  return { fs, host };
}

let fsOf: MemoryFs;

/** The committed generation: the newest manifest. */
async function recordedGeneration(): Promise<number> {
  return (await checkDatabase(fsOf, NAME)).generation!;
}

describe("checkDatabase", () => {
  it("passes a healthy database and folds its state", async () => {
    const { fs } = await seeded();
    const report = await checkDatabase(fs, NAME);
    expect(report.problems).toEqual([]);
    expect(report.head).toBe(12);
    expect(report.ingestedThrough).toBe(11);
    expect(report.runs.some((p) => p.startsWith("l1/"))).toBe(true);
    expect(report.state.map((e) => new TextDecoder().decode(e.key))).toEqual([
      "k1", "k2", "k3", "k4", "k5", "tail",
    ]);
    expect(report.orphans).toEqual([]);
  });

  it("reports a run whose bytes changed", async () => {
    const { fs } = await seeded();
    const meta = await loadGeneration(fs, await recordedGeneration());
    const path = meta!.runs[0]!.path;
    const bytes = (await fs.read(path, 0, Infinity))!;
    bytes[0] = bytes[0]! ^ 0xff;
    const w = await fs.create(path);
    await w.write(bytes);
    await w.finish();
    const report = await checkDatabase(fs, NAME);
    expect(report.problems.join("\n")).toMatch(new RegExp(`${path}.*crc`));
  });

  it("reports a listed run that is gone", async () => {
    const { fs } = await seeded();
    const meta = await loadGeneration(fs, await recordedGeneration());
    await fs.remove(meta!.runs[0]!.path);
    expect((await checkDatabase(fs, NAME)).problems.join("\n")).toMatch(/missing/);
  });

  it("reports L0 runs listed oldest first", async () => {
    const { fs } = await seeded();
    const generation = await recordedGeneration();
    const meta = (await loadGeneration(fs, generation))!;
    // One L0 run after compaction; flush another so there are two.
    const db = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await db.put(utf("k5"), utf("newest"));
    await db.ingest();
    await db.close();
    const g2 = await recordedGeneration();
    const m2 = (await loadGeneration(fs, g2))!;
    const l0 = m2.runs.filter((r) => r.path.startsWith("l0/"));
    expect(l0).toHaveLength(2);
    await publishGeneration(fs, { ...m2, runs: [l0[1]!, l0[0]!, ...m2.runs.slice(2)] });
    const problems = (await checkDatabase(fs, NAME)).problems.join("\n");
    expect(problems).toMatch(/L0 .* not newest first/);
    expect(problems).toMatch(/k5.*: seq 13 in l0\/12-13.sst under a newer seq 11/);
    expect(meta.generation).toBeLessThan(g2);
  });

  it("reports overlapping runs in one level", async () => {
    const { fs } = await seeded();
    const generation = await recordedGeneration();
    const meta = (await loadGeneration(fs, generation))!;
    const l1 = meta.runs.find((r) => r.path.startsWith("l1/"))!;
    await publishGeneration(fs, { ...meta, runs: [...meta.runs, l1] });
    expect((await checkDatabase(fs, NAME)).problems.join("\n")).toMatch(/L1 runs overlap/);
  });

  it("reports a gap in a tab's log", async () => {
    const { fs } = await seeded();
    const db = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await db.put(utf("x"), utf("1"));
    await db.put(utf("y"), utf("2"));
    await db.close();
    // Cut the first record (put x) out of the new tab's segment.
    const putX = [0, 1, 0, 0, 0, 0x78];
    const holds = (b: Uint8Array) => b.some((_, i) => putX.every((v, j) => b[i + j] === v));
    let path: string | undefined;
    for (const tab of await fs.list("w")) {
      for (const file of await fs.list(`w/${tab}`)) {
        if (holds((await fs.read(`w/${tab}/${file}`, 0, Infinity))!)) path = `w/${tab}/${file}`;
      }
    }
    const bytes = (await fs.read(path!, 0, Infinity))!;
    const first = 21 + new DataView(bytes.buffer).getUint32(0, true);
    await fs.remove(path!);
    (await fs.segments().create(path!)).write(bytes.slice(first), 0);
    expect((await checkDatabase(fs, NAME)).problems.join("\n")).toMatch(/first record n 2, name says 1/);
  });

  it("reports a run seq past the manifest's through", async () => {
    const { fs } = await seeded();
    const meta = (await loadGeneration(fs, await recordedGeneration()))!;
    await publishGeneration(fs, { ...meta, through: 3 });
    expect((await checkDatabase(fs, NAME)).problems.join("\n")).toMatch(/past the manifest's through 3/);
  });

  it("counts files no manifest lists as orphans, not problems", async () => {
    const { fs } = await seeded();
    const w = await fs.create("l0/99-99.sst");
    await w.write(utf("junk"));
    await w.finish();
    const report = await checkDatabase(fs, NAME);
    expect(report.problems).toEqual([]);
    expect(report.orphans).toEqual(["l0/99-99.sst"]);
  });
});
