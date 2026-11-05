import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  type ChangeEvent
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

async function deleteIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await deleteIdb("compact");
  __resetMemoryFsForTests("compact");
});

describe("L0 compaction", () => {
  it("merges four L0 runs into L1 and keeps keys readable", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({
      name: "compact",
      writerId: "w1",
      fs,
      forceMemory: true,
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });

    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.ingest();
    }

    const paths = fs.publishedPaths();
    expect(paths.some((p) => p.startsWith("l1/"))).toBe(true);
    // L0 inputs should have been reclaimed
    const l0Left = paths.filter((p) => p.startsWith("l0/"));
    expect(l0Left.length).toBe(0);

    for (let i = 0; i < 4; i++) {
      const v = await db.get(utf(`k${i}`));
      expect(v && new TextDecoder().decode(v)).toBe(`v${i}`);
    }
    await db.close();
  });

  it("a flush returns while compaction merges, and a flush mid-merge stays in front", async () => {
    const fs = new MemoryFs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let merging = false;
    const hostFs: AsyncFs = {
      read: async (path, offset, length) => {
        if (path.endsWith(".sst")) {
          merging = true;
          await gate;
        }
        return fs.read(path, offset, length);
      },
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      create: (path) => fs.create(path),
    };
    const host = new EngineHost(() => hostFs);
    const db = await openHarnessDb({
      name: "compact",
      writerId: "w1",
      fs,
      ingest: createLocalIngestClient(host),
      ingestPolicy: { maxWalBytes: 1e12 },
    });
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));

    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await host.ingest("compact", Number.POSITIVE_INFINITY);
    }
    await vi.waitFor(() => expect(merging).toBe(true));
    await db.put(utf("k0"), utf("newer"));
    await host.ingest("compact", Number.POSITIVE_INFINITY);
    expect((await loadLatestGeneration(fs))!.runs.filter((r) => r.path.startsWith("l0/"))).toHaveLength(5);

    release();
    await host.ingest("compact", Number.POSITIVE_INFINITY, true);
    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs[0]!.path).toMatch(/^l0\//);
    expect(runs.slice(1).every((r) => r.path.startsWith("l1/"))).toBe(true);
    await db.ingest();
    expect(new TextDecoder().decode(await db.get(utf("k0")))).toBe("newer");
    expect(new TextDecoder().decode(await db.get(utf("k3")))).toBe("v3");
    expect(events.some((e) => e.kind === "ingest" && e.writerId === "engine-host")).toBe(true);
    await db.close();
  });
});
