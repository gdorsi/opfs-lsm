import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError, type BatchTx, type Db } from "../src/index.js";
import { __resetMemoryFsForTests, openHarnessDb } from "../src/testing.js";

const NAME = "batch-range-delete";
const enc = new TextEncoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

let db: Db;

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
});

afterEach(async () => {
  await db.close();
  __resetMemoryFsForTests(NAME);
});

const KiB = 1024;
const BATCH_LIMIT = 8 * KiB * KiB;
const OP_OVERHEAD = 256;
const KEY_LIMIT = 8 * KiB;

// Two bounds of the longest key each, so a range delete counts 256 + 16 KiB.
const start = new Uint8Array(KEY_LIMIT).fill(0x61);
const endExclusive = new Uint8Array(KEY_LIMIT).fill(0x61);
endExclusive[KEY_LIMIT - 1] = 0x62;
const RANGE_DELETE_BYTES = OP_OVERHEAD + 2 * KEY_LIMIT;
const RANGE_DELETES = Math.floor(BATCH_LIMIT / RANGE_DELETE_BYTES);
/** What the range deletes leave of the limit for one put. */
const LEFT = BATCH_LIMIT - RANGE_DELETES * RANGE_DELETE_BYTES;

const probe = enc.encode("z");

/** `RANGE_DELETES` range deletes and one put that brings the batch to `LEFT + over` bytes past them. */
function build(over: number): (tx: BatchTx) => void {
  return (tx) => {
    for (let i = 0; i < RANGE_DELETES; i++) tx.deleteRange({ start, endExclusive });
    tx.put(probe, new Uint8Array(LEFT - OP_OVERHEAD - probe.byteLength + over));
  };
}

describe("the batch limit over range deletes", () => {
  it("counts the bounds of a range delete: a batch of exactly 8 MiB of them is stored, and one byte more is rejected", async () => {
    expect(LEFT).toBeGreaterThan(OP_OVERHEAD + probe.byteLength);

    const refused = await db.batch(build(1)).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ConstraintError);
    expect(await db.get(probe), "a refused batch writes none of its ops").toBeUndefined();

    const seq = await db.batch(build(0));
    expect(seq).toBe(1);
    expect((await db.get(probe))?.byteLength).toBe(LEFT - OP_OVERHEAD - probe.byteLength);
  });
});
