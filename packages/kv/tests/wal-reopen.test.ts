import { afterEach, describe, expect, it } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "wal-reopen";
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

afterEach(async () => {
  await wipe();
  __resetMemoryFsForTests(NAME);
});

describe("reopen", () => {
  it("reopens every acked put from the WAL", async () => {
    const writer = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    const n = 200;
    for (let i = 0; i < n; i++) {
      await writer.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
    }
    await writer.close();

    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w2",
      maxWalBytes: 1 << 30,
    });
    for (let i = 0; i < n; i++) {
      expect(dec.decode(await reader.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
    }
    const seen: string[] = [];
    for await (const entry of reader.range()) {
      seen.push(dec.decode(entry.key));
    }
    expect(seen).toHaveLength(n);
    await reader.close();
  });

  it("reopens every acked put from a WAL tail longer than one read", async () => {
    const writer = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    // The tail is read in ranges of 25,000 seqs.
    const n = 25_001;
    const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
    const seqs = await Promise.all(Array.from({ length: n }, (_, i) => writer.put(key(i), enc.encode(`v${i}`))));
    expect(seqs.at(-1)).toBe(n);
    await writer.close();

    const reader = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w2", maxWalBytes: 1 << 30 });
    expect(await reader.count()).toBe(n);
    for (const i of [0, 24_999, 25_000]) {
      expect(dec.decode(await reader.get(key(i)))).toBe(`v${i}`);
    }
    await reader.close();
  }, 30_000);
});
