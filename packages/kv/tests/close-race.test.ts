import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClosedError, type Db } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "close-race-test";
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

describe("close during a write", () => {
  it("resolves a put whose append committed before close", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const put = db.put(enc.encode("k"), enc.encode("v"));
    await db.close();
    const outcome = await put.then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    );

    const reopened = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w2" });
    const stored = await reopened.get(enc.encode("k"));
    await reopened.close();

    expect(stored && dec.decode(stored)).toBe("v");
    expect(outcome).toBe("resolved");
  });

  it("resolves an update whose body ran before close, and its write is stored", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    let ran!: () => void;
    const inBody = new Promise<void>((resolve) => (ran = resolve));
    const update = db.update([enc.encode("k")], (_values, tx) => {
      ran();
      tx.put(enc.encode("k"), enc.encode("v"));
      return "done";
    });
    await inBody;
    await db.close();
    expect(await update).toBe("done");

    const reopened = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w2" });
    const stored = await reopened.get(enc.encode("k"));
    await reopened.close();
    expect(stored && dec.decode(stored)).toBe("v");
  });

  it("rejects an update with ClosedError when close comes in the same turn, and writes nothing", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    let runs = 0;
    const update = db.update([enc.encode("k")], (_values, tx) => {
      runs += 1;
      tx.put(enc.encode("k"), enc.encode("v"));
    });
    await db.close();
    await expect(update).rejects.toBeInstanceOf(ClosedError);
    expect(runs).toBe(0);

    const reopened = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w2" });
    expect(await reopened.get(enc.encode("k"))).toBeUndefined();
    await reopened.close();
  });

  it("resolves a put whose append committed before close while its catch-up waited on a sync", async () => {
    const writer = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w0" });
    const db = await openWithoutBus("w1");
    // Another tab's write this handle has not read, so its own row lands past a gap.
    await writer.put(enc.encode("other"), enc.encode("1"));
    const barrier = await rawWal();
    const put = db.put(enc.encode("k"), enc.encode("v"));
    // Runs after the put's transaction and before the sync's tail read: the put
    // has landed, found the gap, and waits on the sync below.
    const between = barrier.transaction("wal", "readwrite");
    const landed = new Promise<void>((resolve) => (between.oncomplete = () => resolve()));
    const sync = db.sync();
    await landed;
    barrier.close();
    await db.close();
    expect(await outcome(put)).toBe("resolved");
    expect(await outcome(sync)).toBe("resolved");

    const reopened = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w2" });
    const stored = await reopened.get(enc.encode("k"));
    await reopened.close();
    await writer.close();
    expect(stored && dec.decode(stored)).toBe("v");
  });
});

describe("close during a sync", () => {
  it("settles every sync made before close as a lone one does", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const lone = db.sync();
    await db.close();
    expect(await outcome(lone)).toBe("resolved");

    const again = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1" });
    const first = again.sync();
    const second = again.sync();
    await again.close();
    expect([await outcome(first), await outcome(second)]).toEqual(["resolved", "resolved"]);
  });
});

function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
  );
}

/** A handle that gets no BroadcastChannel message, so it learns of other writes only from the WAL. */
async function openWithoutBus(writerId: string): Promise<Db> {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await openHarnessDb({ name: NAME, forceMemory: true, writerId });
  } finally {
    g.BroadcastChannel = real;
  }
}

/** A connection of the test's own to the WAL database, whose transactions order the handle's. */
function rawWal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
