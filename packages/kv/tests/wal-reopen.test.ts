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
});
