import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "changes-listener-closes";
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
});

const open = (writerId: string) => openHarnessDb({ name: NAME, forceMemory: true, writerId });
const seqs = (events: ChangeEvent[]) => events.map((e) => (e.kind === "append" ? e.seq : e.kind));

/** A handle that gets no BroadcastChannel message, so one `sync()` applies every write it has not read. */
async function openWithoutBus(writerId: string): Promise<Db> {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await open(writerId);
  } finally {
    g.BroadcastChannel = real;
  }
}

/** A listener that closes `db` on the first event it hears, and one subscribed after it. */
function closerAndOther(db: Db): { closer: ChangeEvent[]; other: ChangeEvent[] } {
  const closer: ChangeEvent[] = [];
  const other: ChangeEvent[] = [];
  db.changes((e) => {
    closer.push(e);
    if (closer.length === 1) void db.close();
  });
  db.changes((e) => other.push(e));
  return { closer, other };
}

describe("a changes() listener that closes the handle", () => {
  it("leaves every other listener the event it closed on, then closed", async () => {
    const db = await open("w");
    const { closer, other } = closerAndOther(db);

    const seq = await db.put(b(1), b(1));

    expect(seqs(closer)).toEqual([seq, "closed"]);
    expect(seqs(other)).toEqual([seq, "closed"]);
  });

  it("leaves every listener the records its handle applied with that one, then closed", async () => {
    const writer = await open("w");
    const reader = await openWithoutBus("r");
    const { closer, other } = closerAndOther(reader);
    const first = await writer.put(b(1), b(1));
    const second = await writer.put(b(2), b(2));

    await reader.sync();

    expect(seqs(closer)).toEqual([first, second, "closed"]);
    expect(seqs(other)).toEqual([first, second, "closed"]);
    await writer.close();
  });
});
