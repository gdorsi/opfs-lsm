import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClosedError } from "../src/index.js";
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
});
