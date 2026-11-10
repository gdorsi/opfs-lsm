import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, type ChangeEvent } from "../src/index.js";
import { Host, openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

afterEach(() => {
  __resetMemoryFsForTests("compact");
});

describe("L0 compaction", () => {
  it("merges four L0 runs into L1 and keeps keys readable", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: "compact", fs });

    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.ingest();
    }

    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs.map((r) => r.path.slice(0, 3))).toEqual(["l1/"]);
    for (let i = 0; i < 4; i++) {
      const v = await db.get(utf(`k${i}`));
      expect(v && new TextDecoder().decode(v)).toBe(`v${i}`);
    }
    await db.close();
  });

  it("an ingest returns while compaction merges, and an ingest mid-merge stays in front", async () => {
    const fs = new MemoryFs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let merging = false;
    const hostFs: AsyncFs = {
      read: async (path, offset, length) => {
        // A merge reads whole runs; recovery's intact check reads one byte.
        if (path.endsWith(".sst") && length > 1) {
          merging = true;
          await gate;
        }
        return fs.read(path, offset, length);
      },
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      open: (path) => fs.open(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const host = new Host(() => hostFs);
    const db = await openHarnessDb({ name: "compact", fs, segments: fs.segments, host });
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));

    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.sync();
    }
    await vi.waitFor(() => expect(merging).toBe(true));
    await db.put(utf("k0"), utf("newer"));
    await db.sync();
    expect((await loadLatestGeneration(fs))!.runs.filter((r) => r.path.startsWith("l0/"))).toHaveLength(5);

    release();
    await db.ingest();
    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs[0]!.path).toMatch(/^l0\//);
    expect(runs.slice(1).every((r) => r.path.startsWith("l1/"))).toBe(true);
    expect(new TextDecoder().decode(await db.get(utf("k0")))).toBe("newer");
    expect(new TextDecoder().decode(await db.get(utf("k3")))).toBe("v3");
    expect(events.filter((e) => e.kind === "ingest").length).toBeGreaterThanOrEqual(6);
    await db.close();
  });
});
