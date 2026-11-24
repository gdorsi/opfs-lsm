/**
 * README "Testing" and `HarnessOpenOptions.ingest`: without `ingest`,
 * `openHarnessDb` flushes through an in-process EngineHost on the fs it was
 * given. A suite that gives each test a fresh `MemoryFs` and a fresh
 * IndexedDB under one database name relies on it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingest, MemoryFs, openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "harness-fs";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

function wipe(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => __resetMemoryFsForTests(NAME));

/** One test of an app's suite: its own fs, a put, a flush, and a reopen that reads the put from the run. */
async function oneTest(value: string): Promise<string | undefined> {
  const fs = new MemoryFs();
  const db = await openHarnessDb({ name: NAME, fs });
  await db.put(utf("k"), utf(value));
  await ingest(db);
  await db.close();

  const again = await openHarnessDb({ name: NAME, fs });
  const got = await again.get(utf("k"));
  await again.close();
  await wipe();
  return got && dec.decode(got);
}

describe("openHarnessDb with an fs of the caller's", () => {
  it("flushes to the fs it was given, also when an earlier open of the name was given another", async () => {
    expect(await oneTest("first")).toBe("first");
    expect(await oneTest("second")).toBe("second");
  });
});
