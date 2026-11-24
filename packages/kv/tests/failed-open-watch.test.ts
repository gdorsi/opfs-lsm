import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  type AsyncFs,
} from "../src/testing.js";
import type { ReadFs } from "../src/opfs/async-fs.js";
import { loadLatestGeneration } from "./latest-generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const NAME = "failed-open-watch";
const WAIT = { timeout: 2000, interval: 5 };
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

/** A tab fs whose every read fails, as an OPFS read the browser refuses. */
const broken = (): ReadFs => ({
  read: () => Promise.reject(new Error("read refused")),
  open: () => Promise.reject(new Error("open refused")),
  list: () => Promise.reject(new Error("list refused")),
});

describe("a failed open leaves other tabs' host watch alone", () => {
  it("the host still ingests at maxWalBytes for the open tab after another tab's open failed", async () => {
    const fs: AsyncFs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const a = await openHarnessDb({ name: NAME, writerId: "a", fs, maxWalBytes: 100, ingest: createLocalIngestClient(host) });
    opened.push(a);

    // A second tab whose open fails before it ever asked the host to watch.
    await expect(
      openHarnessDb({ name: NAME, writerId: "b", fs, maxWalBytes: 100, wrapFs: broken, ingest: createLocalIngestClient(host) }),
    ).rejects.toThrow(/refused/);

    // Tab A writes past its maxWalBytes: the host should flush, as it does with no failed open.
    await a.put(utf("a"), new Uint8Array(60));
    await a.put(utf("b"), new Uint8Array(60));
    await settle();
    await vi.waitFor(async () => expect(await loadLatestGeneration(fs)).toBeDefined(), WAIT);
  });

  it("control: with no failed open, the same writes flush", async () => {
    const fs: AsyncFs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const a = await openHarnessDb({ name: NAME, writerId: "a", fs, maxWalBytes: 100, ingest: createLocalIngestClient(host) });
    opened.push(a);
    await a.put(utf("a"), new Uint8Array(60));
    await a.put(utf("b"), new Uint8Array(60));
    await settle();
    await vi.waitFor(async () => expect(await loadLatestGeneration(fs)).toBeDefined(), WAIT);
  });
});
