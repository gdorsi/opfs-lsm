import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";
import { watchWalGroups } from "./wal-groups.js";

const NAME = "update-after-queued-put";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

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
  vi.restoreAllMocks();
  __resetMemoryFsForTests(NAME);
});

describe("an update issued after a put of its handle that waits for the next group", () => {
  it("reads that put and lands after it", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, maxWalBytes: 1 << 30 });
    await db.put(utf("k"), utf("0"));
    const groups = watchWalGroups();

    const first = db.put(utf("k"), utf("a"));
    // The first put's group takes no append once the microtask that commits it ran.
    await Promise.resolve();
    const second = db.put(utf("k"), utf("b"));
    const read = db.update([utf("k")], ([value], tx) => {
      tx.put(utf("k"), utf(`${text(value)}+1`));
      return text(value);
    });

    expect(await read).toBe("b");
    expect(await first).toBeLessThan(await second);
    expect(groups, "the second put waited for the next group").toEqual([1, 1]);
    expect(text(await db.get(utf("k")))).toBe("b+1");
    await db.close();
  });
});
