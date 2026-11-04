import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryFs,
  __resetMemoryFsForTests,
  openDb,
} from "../src/index.js";

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
    const db = await openDb({
      name: "compact",
      writerId: "w1",
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30, maxDelayMs: 60_000 },
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
});
