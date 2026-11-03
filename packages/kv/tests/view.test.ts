import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, __resetMemoryFsForTests } from "../src/index.js";

const NAME = "view-test";
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

describe("view snapshot", () => {
  it("pins WAL head so later puts are invisible", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));

    const seen = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode("2"));
      await db.put(enc.encode("b"), enc.encode("x"));
      const a = await snap.get(enc.encode("a"));
      const b = await snap.get(enc.encode("b"));
      return {
        a: a ? dec.decode(a) : undefined,
        b: b ? dec.decode(b) : undefined,
        head: snap.walHead,
      };
    });

    expect(seen.a).toBe("1");
    expect(seen.b).toBeUndefined();
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
    await db.close();
  });

  it("closes snapshot after callback", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    let leaked: { get(key: Uint8Array): Promise<Uint8Array | undefined> } | undefined;
    await db.view(async (snap) => {
      leaked = snap;
      return null;
    });
    await expect(leaked!.get(enc.encode("a"))).rejects.toThrow(/closed/);
    await db.close();
  });
});
