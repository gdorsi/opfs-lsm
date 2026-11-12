import { afterEach, beforeEach, expect, it } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests, ingest, MemoryFs } from "../src/testing.js";

const NAME = "update-large-read";
const KEYS = 4_000;
const VALUE_BYTES = 1_024;

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const key = (i: number) => new TextEncoder().encode(`k${String(i).padStart(6, "0")}`);

/** Incompressible, so the run's pages hold what the values weigh. */
function value(i: number): Uint8Array {
  const out = new Uint8Array(VALUE_BYTES);
  let x = (i + 1) * 2654435761;
  for (let b = 0; b < out.length; b++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[b] = x >>> 24;
  }
  return out;
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => __resetMemoryFsForTests(NAME));

it("update reads more cold run bytes than the cache budget holds", async () => {
  const fs = new MemoryFs();
  const open = () =>
    openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, maxWalBytes: 1 << 30, cacheBytes: 1 });
  const writer = await open();
  for (let from = 0; from < KEYS; from += 500) {
    await writer.batch((tx) => {
      for (let i = from; i < from + 500; i++) tx.put(key(i), value(i));
    });
  }
  await ingest(writer);
  await writer.close();

  const db = await open();
  const keys = Array.from({ length: KEYS }, (_, i) => key(i));
  const sizes = await db.update(keys, (values) => values.map((v) => v?.byteLength));
  expect(sizes).toEqual(keys.map(() => VALUE_BYTES));
  expect(await db.update([key(7)], ([v]) => v)).toEqual(value(7));
  await db.close();
}, 20_000);
