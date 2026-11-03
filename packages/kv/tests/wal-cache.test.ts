import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, __resetMemoryFsForTests } from "../src/index.js";

const NAME = "wal-cache-test";
const enc = new TextEncoder();
const dec = new TextDecoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

describe("WAL overlay cache", () => {
  it("serves repeated gets without losing visibility", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    await db.put(enc.encode("a"), enc.encode("2"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("2");
    await db.close();
  });

  it("invalidates after ingest so SST still serves values", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    await db.ingest();
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.close();
  });
});
