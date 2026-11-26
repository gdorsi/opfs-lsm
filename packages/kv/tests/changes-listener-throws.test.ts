import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "changes-listener-throws";
const b = (...bytes: number[]) => Uint8Array.from(bytes);

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
  vi.restoreAllMocks();
});

const open = (writerId: string) => openHarnessDb({ name: NAME, forceMemory: true, writerId, rowPostMs: 0 });
const seqs = (events: ChangeEvent[]) => events.map((e) => (e.kind === "append" ? e.seq : e.kind));

describe("a changes() listener that throws", () => {
  it("fails neither the write nor the catch-up, and every other listener hears every event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = await open("w");
    const reader = await open("r");
    const heard: ChangeEvent[] = [];
    const heardOnReader: ChangeEvent[] = [];
    writer.changes(() => {
      throw new Error("listener bug");
    });
    writer.changes((e) => heard.push(e));
    reader.changes(() => {
      throw new Error("listener bug");
    });
    reader.changes((e) => heardOnReader.push(e));

    const s1 = await writer.put(b(1), b(1));
    const s2 = await writer.batch((tx) => tx.delete(b(1)));
    const s3 = await writer.update([b(2)], (_values, tx) => tx.put(b(2), b(2))).then(() => writer.batch(() => {}));
    expect(seqs(heard)).toEqual([s1, s2, s3]);
    expect(await writer.get(b(2))).toEqual(b(2));

    await reader.sync();
    expect(seqs(heardOnReader)).toEqual([s1, s2, s3]);
    expect(await reader.getMany([b(1), b(2)])).toEqual([undefined, b(2)]);
    expect(error).toHaveBeenCalled();

    await writer.close();
    await reader.close();
    expect(seqs(heard).at(-1)).toBe("closed");
  });

  it("keeps announcing later events when console.error throws as well", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console.error fails the test run");
    });
    const db = await open("w");
    const heard: ChangeEvent[] = [];
    let buggy = true;
    db.changes(() => {
      if (buggy) throw new Error("listener bug");
    });
    db.changes((e) => heard.push(e));

    await db.put(b(1), b(1)).catch(() => undefined);
    expect(error).toHaveBeenCalled();
    buggy = false;
    const s2 = await db.put(b(2), b(2));
    await db.close();
    expect(seqs(heard).slice(-2)).toEqual([s2, "closed"]);
  });
});
