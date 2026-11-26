import { afterEach, describe, expect, it } from "vitest";
import { checkDbName } from "../src/check.js";
import { holdingFiles } from "../src/locks.js";
import { openExistingWal } from "../src/idb/wal.js";
import type { Db } from "../src/index.js";
import { loadGeneration } from "../src/store/generation.js";
import { levelOf } from "../src/store/levels.js";
import { createLocalIngestClient, EngineHost, MemoryFs, openHarnessDb } from "../src/testing.js";

/** A host skips the check of a generation it published itself: a tab's request must make it look again. */
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

describe("a host that published the recorded generation itself", () => {
  it("checks it again when a tab's load finds a run gone, and records the manifest that can stand in", async () => {
    const name = "repair-own-generation";
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const open = async () => {
      const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
      opened.push(db);
      return db;
    };
    const first = await open();

    // A tab that holds the reclaim lock: the host removes nothing, so the manifest before the merge and its runs stay.
    let release!: () => void;
    let granted!: () => void;
    const held = new Promise<void>((resolve) => (granted = resolve));
    const holding = holdingFiles(name, () => {
      granted();
      return new Promise<void>((resolve) => (release = resolve));
    });
    await held;
    for (let i = 0; i < 4; i++) {
      await first.put(utf(`k${i}`), utf(`v${i}`));
      await host.ingest(name, true);
    }
    await first.close();
    opened.splice(0);

    const wal = (await openExistingWal(checkDbName(name)))!;
    const before = await wal.meta();
    const merged = (await loadGeneration(fs, before.generation!))!;
    const output = merged.runs.find((run) => levelOf(run.path) === 1)!;
    expect(merged.runs, "the host merged the four flushes into L1").toEqual([output]);
    // The run goes, while the host that wrote it lives on.
    await fs.remove(output.path);

    const second = await open();
    release();
    await holding;
    for (let i = 0; i < 4; i++) expect(await second.get(utf(`k${i}`))).toEqual(utf(`v${i}`));
    const after = await wal.meta();
    wal.close();
    expect(after.generation).toBeLessThan(before.generation!);
    expect(after.ingestedThrough).toBe(before.ingestedThrough);
    expect(after.head).toBe(before.head);

    // The host builds on what it recorded: a flush and its merge land, and no row is lost.
    await second.put(utf("k4"), utf("v4"));
    await host.ingest(name, true);
    await second.sync();
    for (let i = 0; i < 5; i++) expect(await second.get(utf(`k${i}`))).toEqual(utf(`v${i}`));
  });
});
