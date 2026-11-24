import { afterEach, describe, expect, it } from "vitest";
import { prefixBound, type Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, settle, type AsyncFs } from "../src/testing.js";
import { loadLatestGeneration } from "./latest-generation.js";

const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe("dangerousDestroy during a compaction pass", () => {
  it("lets the step in flight install and starts none of the steps the pass had left", async () => {
    const name = "destroy-stops-compaction";
    const fs = new MemoryFs();
    let armed = false;
    let entered!: () => void;
    const inStep = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Only the host reads through this: the first input a step opens once armed waits at the gate.
    const hostFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      open: async (path) => {
        if (armed && path.startsWith("l1/")) {
          entered();
          await gate;
        }
        return fs.open(path);
      },
    };
    const host = new EngineHost(() => hostFs);
    const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
    opened.push(db);

    // Forty disjoint groups, four per flush merge: ten L1 runs.
    for (let g = 0; g < 40; g++) {
      await db.put(b(`g/${String(g).padStart(2, "0")}`), b("x".repeat(100)));
      await ingest(db);
    }
    await settle(db);
    expect((await loadLatestGeneration(fs))!.runs.length, "more runs than one pass rewrites").toBeGreaterThan(8);

    // One range delete over all ten runs: the next pass has a mark step for each.
    await db.batch((tx) => tx.deleteRange(prefixBound(b("g/"))));
    armed = true;
    await host.ingest(name, false);
    await inStep;
    const before = (await host.stats(name)).compactionSteps;

    const destroyed = db.dangerousDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await destroyed;
    armed = false;
    await ingest(db);

    expect((await host.stats(name)).compactionSteps - before).toBe(1);
    expect(await db.count()).toBe(0);
    await db.put(b("after"), b("v"));
    await ingest(db);
    expect(await db.get(b("after"))).toEqual(b("v"));
  });
});
