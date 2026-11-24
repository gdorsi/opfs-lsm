import { afterEach, describe, expect, it } from "vitest";
import { checkDbName } from "../src/check.js";
import { DEFAULT_COMPACTION_MEMORY_BYTES, hostBudget } from "../src/host/budget.js";
import { installStep, mergeNextStep } from "../src/host/compact.js";
import { openExistingWal } from "../src/idb/wal.js";
import type { Db } from "../src/index.js";
import { compactLock } from "../src/locks.js";
import { loadGeneration } from "../src/store/generation.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

/** Takes Web Lock `name` and resolves with its release. */
function holdLock(name: string): Promise<() => void> {
  return new Promise((granted) => {
    void navigator.locks.request(name, () => new Promise<void>((release) => granted(release)));
  });
}

describe("a compaction install", () => {
  it("installs nothing once its inputs left the recorded generation, so a merge of destroyed rows brings none back", async () => {
    const name = "install-stale-inputs";
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
    opened.push(db);
    // No pass of the host runs while this holds the compaction lock: four L0 runs stay.
    const release = await holdLock(compactLock(name));
    for (let i = 0; i < 4; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await host.ingest(name, false);
    }
    const wal = (await openExistingWal(checkDbName(name)))!;
    try {
      const meta = await wal.meta();
      const base = (await loadGeneration(fs, meta.generation!))!;
      expect(base.runs).toHaveLength(4);
      const step = (await mergeNextStep(fs, hostBudget(DEFAULT_COMPACTION_MEMORY_BYTES), base, meta.top))!;
      expect(step.inputs).toHaveLength(4);
      expect(step.outputs.length).toBeGreaterThan(0);

      release();
      await db.dangerousDestroy();
      await db.put(utf("after"), utf("kept"));
      await ingest(db);
      const recorded = await wal.meta();
      const manifests = [...(await fs.list("m"))].sort();

      await expect(installStep(fs, wal, step, undefined)).rejects.toThrow("compaction inputs left the recorded generation");
      expect(await wal.meta()).toEqual(recorded);
      expect([...(await fs.list("m"))].sort()).toEqual(manifests);
      await db.sync();
      for (let i = 0; i < 4; i++) expect(await db.get(utf(`k${i}`))).toBeUndefined();
      expect(await db.get(utf("after"))).toEqual(utf("kept"));
    } finally {
      release();
      wal.close();
    }
  });
});
