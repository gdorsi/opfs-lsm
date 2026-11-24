import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadFs } from "../src/opfs/async-fs.js";
import { openHarnessDb, __resetMemoryFsForTests, ingest } from "../src/testing.js";

const NAME = "sync-during-catchup";
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

/** A read fs whose calls wait while `closed` is set, so a catch-up that loads a generation stays in flight. */
function gated(inner: ReadFs) {
  let open!: () => void;
  let gate: Promise<void> | undefined;
  const wait = () => gate ?? Promise.resolve();
  const fs: ReadFs = {
    read: (path, offset, length) => wait().then(() => inner.read(path, offset, length)),
    open: (path) => wait().then(() => inner.open(path)),
    list: (dir) => wait().then(() => inner.list(dir)),
  };
  return {
    fs,
    close: () => (gate = new Promise((resolve) => (open = resolve))),
    open: () => {
      gate = undefined;
      open();
    },
  };
}

describe("sync() while a catch-up is in flight", () => {
  it("still catches up to a write acked after that catch-up read the WAL", async () => {
    let gate!: ReturnType<typeof gated>;
    // The writer posts its first row at once and holds later ones for a minute, so only the WAL carries the write under test.
    const writer = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w", rowPostMs: 60_000 });
    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "r",
      wrapFs: (fs) => (gate = gated(fs)).fs,
    });
    await writer.put(b(1), b(1));
    await reader.sync();
    expect(await reader.get(b(1))).toEqual(b(1));

    // A flush the reader has not loaded: its next catch-up reads the WAL, then waits on the gated fs.
    gate.close();
    await ingest(writer);
    const first = reader.sync();
    // Let the catch-up read its tail and reach the fs.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await writer.put(b(2), b(2));
    const second = reader.sync();
    gate.open();
    await Promise.all([first, second]);
    expect(await reader.get(b(2)), "a sync called after the ack reads the write").toEqual(b(2));

    await writer.close();
    await reader.close();
  });
});
