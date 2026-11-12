import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../src/testing.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { throughAt } from "../src/store/marks.js";
import { decodeSst } from "../src/store/sst.js";

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
      maxWalBytes: 1 << 30,
    });

    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await ingest(db);
    }

    expect(fs.publishedPaths().some((p) => p.startsWith("l1/"))).toBe(true);
    for (let i = 0; i < 4; i++) {
      const v = await db.get(utf(`k${i}`));
      expect(v && new TextDecoder().decode(v)).toBe(`v${i}`);
    }

    await ingest(db);
    expect(fs.publishedPaths().filter((p) => p.startsWith("l0/"))).toEqual([]);
    await db.close();
  });

  it("a flush returns while compaction merges, and a flush mid-merge stays in front", async () => {
    const fs = new MemoryFs();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let merging = false;
    // Compaction is the only host work that opens a run.
    const hostFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      open: async (path) => {
        if (path.endsWith(".sst")) {
          merging = true;
          await gate;
        }
        return fs.open(path);
      },
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const host = new EngineHost(() => hostFs);
    const db = await openHarnessDb({
      name: "compact",
      writerId: "w1",
      fs,
      ingest: createLocalIngestClient(host),
      maxWalBytes: 1e12,
    });
    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await host.ingest("compact");
    }
    await vi.waitFor(() => expect(merging).toBe(true));
    await db.put(utf("k0"), utf("newer"));
    await host.ingest("compact");
    expect((await loadLatestGeneration(fs))!.runs.filter((r) => r.path.startsWith("l0/"))).toHaveLength(5);

    release();
    await host.ingest("compact", true);
    const runs = (await loadLatestGeneration(fs))!.runs;
    expect(runs[0]!.path).toMatch(/^l0\//);
    expect(runs.slice(1).every((r) => r.path.startsWith("l1/"))).toBe(true);
    await ingest(db);
    expect(new TextDecoder().decode(await db.get(utf("k0")))).toBe("newer");
    expect(new TextDecoder().decode(await db.get(utf("k3")))).toBe("v3");
    await db.close();
  });

  it("a range delete flushed during a merge is not claimed by the merge's output", async () => {
    const fs = new MemoryFs();
    // The first merge's four inputs wait for `first`, every later open for `later`.
    let opens = 0;
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const later = new Promise<void>((r) => (releaseLater = r));
    const hostFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      open: async (path) => {
        if (path.endsWith(".sst")) await (++opens <= 4 ? first : later);
        return fs.open(path);
      },
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const host = new EngineHost(() => hostFs);
    const db = await openHarnessDb({ name: "compact", writerId: "w1", fs, ingest: createLocalIngestClient(host), maxWalBytes: 1e12 });
    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await host.ingest("compact");
    }
    await vi.waitFor(() => expect(opens).toBe(1));
    const base = (await loadLatestGeneration(fs))!;
    await db.batch((tx) => tx.deleteRange({ start: utf("k1"), endExclusive: utf("k3") }));
    await host.ingest("compact");
    expect(throughAt((await loadLatestGeneration(fs))!.marks, utf("k1"))).toBeGreaterThan(0);

    releaseFirst();
    const merged = async () => (await loadLatestGeneration(fs))!;
    await vi.waitFor(async () => expect((await merged()).runs.some((r) => r.path.startsWith("l1/"))).toBe(true));
    expect((await merged()).runs.map((r) => [r.path.slice(0, 3), r.marksThrough])).toEqual([["l1/", base.through]]);
    expect(throughAt((await merged()).marks, utf("k1")), "the mark the merge never saw stays").toBeGreaterThan(0);
    await db.sync();
    expect(await db.get(utf("k1"))).toBeUndefined();
    expect(await db.get(utf("k2"))).toBeUndefined();

    releaseLater();
    await host.ingest("compact", true);
    const absorbed = (await loadLatestGeneration(fs))!;
    expect(absorbed.marks.empty, "a mark step then absorbs it").toBe(true);
    const onDisk: string[] = [];
    for (const run of absorbed.runs) for (const e of decodeSst((await fs.read(run.path, 0, Infinity))!)) onDisk.push(new TextDecoder().decode(e.key));
    expect(onDisk.sort()).toEqual(["k0", "k3"]);
    await db.close();
  });
});
