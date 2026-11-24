import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, MemoryFs, openHarnessDb } from "../src/testing.js";
import { loadLatestGeneration } from "./latest-generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const WAIT = { timeout: 3000, interval: 5 };
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe("the flushes the host starts on its own", () => {
  it("are followed by compaction, so L0 stays within its budget with no tab asking", async () => {
    const name = "host-flush-compacts";
    const fs = new MemoryFs();
    // No idle pass during the test: only a flush can start one.
    const host = new EngineHost(() => fs, { idleFlushMs: 600_000, idleFlushDueMs: 600_000 });
    const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 200 });
    opened.push(db);

    const FLUSHES = 12;
    for (let i = 0; i < FLUSHES; i++) {
      // One row past maxWalBytes: the host flushes it with no request from the tab.
      await db.put(utf(`k${String(i).padStart(2, "0")}`), new Uint8Array(250).fill(i));
      await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.through).toBe(i + 1), WAIT);
    }

    await vi.waitFor(async () => {
      const stats = await host.stats(name);
      expect(stats.flushes).toBe(FLUSHES);
      expect(stats.compactionSteps).toBeGreaterThan(0);
      expect(stats.layout.find((level) => level.level === 0)?.runs ?? 0).toBeLessThan(4);
    }, WAIT);
    await db.sync();
    for (let i = 0; i < FLUSHES; i++) {
      expect(await db.get(utf(`k${String(i).padStart(2, "0")}`))).toEqual(new Uint8Array(250).fill(i));
    }
  });
});
