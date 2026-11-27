import { afterEach, expect, it, vi } from "vitest";
import { checkDbName } from "../src/check.js";
import { openExistingWal } from "../src/idb/wal.js";
import { holdingFiles } from "../src/locks.js";
import type { Db } from "../src/index.js";
import { loadGeneration } from "../src/store/generation.js";
import { createLocalIngestClient, destroyHarnessDb, EngineHost, MemoryFs, openHarnessDb } from "../src/testing.js";

const NAME = "sweep-untrusted";
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

/**
 * A host sweeps after a compaction pass that installed nothing only against
 * a generation it checked itself. Here another host recorded a generation
 * that lists a run that is gone, and an older intact manifest can stand in
 * for it (design.md, "Corruption is not a power loss"). An idle pass of a
 * host that never checked it must leave the stand-in, so a tab still opens
 * and reads every row.
 */
it("an idle pass of a host that never checked the recorded generation keeps the manifest that can stand in for it", async () => {
  const fs = new MemoryFs();
  const writer = new EngineHost(() => fs);
  const first = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(writer), maxWalBytes: 1 << 30 });

  // A tab holds the reclaim lock while the writing host flushes four runs and merges them, so every older manifest stays.
  let release!: () => void;
  let granted!: () => void;
  const held = new Promise<void>((resolve) => (granted = resolve));
  const holding = holdingFiles(NAME, () => {
    granted();
    return new Promise<void>((resolve) => (release = resolve));
  });
  await held;
  for (let i = 0; i < 4; i++) {
    await first.put(utf(`k${i}`), utf(`v${i}`));
    await writer.ingest(NAME, true);
  }
  await first.close();
  release();
  await holding;

  const wal = (await openExistingWal(checkDbName(NAME)))!;
  const merged = (await loadGeneration(fs, (await wal.meta()).generation!))!;
  wal.close();
  const output = merged.runs.find((run) => run.level === 1)!;
  expect(merged.runs, "the four flushes merged into one L1 run").toEqual([output]);
  await fs.remove(output.path);

  // Another host, which never checked the recorded generation, runs an idle compaction pass.
  let calls = 0;
  const counted = new Proxy(fs, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => (calls++, (member as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
  const idle = new EngineHost(() => counted, { idleFlushMs: 5 });
  const client = createLocalIngestClient(idle);
  client.watch(NAME, { maxWalBytes: 1 << 30, compactionMemoryBytes: 32 << 20, reserveBytes: 0 });
  // The pass reads the folder, then sweeps or not: wait for the reads, then until the host is quiet.
  await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 10_000 });
  for (let seen = -1; seen !== calls; ) {
    seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  client.unwatch(NAME);

  const second = await openHarnessDb({ name: NAME, fs, ingest: client, maxWalBytes: 1 << 30 });
  opened.push(second);
  for (let i = 0; i < 4; i++) expect(await second.get(utf(`k${i}`))).toEqual(utf(`v${i}`));
  await second.close();
  opened.splice(0);
  await destroyHarnessDb({ name: NAME, fs });
});
