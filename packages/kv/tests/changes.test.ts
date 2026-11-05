import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDb,
  __resetMemoryFsForTests,
  type ChangeEvent,
} from "../src/index.js";

const NAME = "changes-test";
const enc = new TextEncoder();

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

describe("changes()", () => {
  it("notifies local appends and ingest", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxBytes: 1 << 30 },
    });
    const events: ChangeEvent[] = [];
    const stop = db.changes((e) => events.push(e));

    await db.put(enc.encode("a"), enc.encode("1"));
    expect(events).toEqual([
      { kind: "append", writerId: "w1", seq: 1 },
    ]);

    await db.ingest();
    expect(events.at(-1)).toEqual({ kind: "ingest", writerId: "w1" });

    stop();
    await db.put(enc.encode("b"), enc.encode("2"));
    expect(events.filter((e) => e.kind === "append")).toHaveLength(1);
    await db.close();
  });

  it("receives appends from another writer on the same db name", async () => {
    if (typeof BroadcastChannel === "undefined") return;

    const a = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "wa",
      ingestPolicy: { maxBatches: 1e9, maxBytes: 1 << 30 },
    });
    const b = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "wb",
      ingestPolicy: { maxBatches: 1e9, maxBytes: 1 << 30 },
    });

    const events: ChangeEvent[] = [];
    b.changes((e) => events.push(e));

    await a.put(enc.encode("k"), enc.encode("v"));
    await new Promise((r) => setTimeout(r, 20));

    expect(events.some((e) => e.kind === "append" && e.writerId === "wa")).toBe(
      true,
    );
    await a.close();
    await b.close();
  });
});
