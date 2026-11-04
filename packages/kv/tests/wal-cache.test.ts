import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDbName } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";
import { openDb, __resetMemoryFsForTests } from "../src/index.js";

const NAME = "wal-cache-test";
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

describe("memtable reads", () => {
  it("serves repeated gets without losing visibility", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    const other = await IdBWal.open(checkDbName(NAME));
    const row = await other.memGet(enc.encode("a"));
    other.close();
    expect(row?.kind).toBe("put");
    expect(row?.value && dec.decode(row.value)).toBe("1");
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    await db.put(enc.encode("a"), enc.encode("2"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("2");
    await db.close();
  });

  it("invalidates after ingest so SST still serves values", async () => {
    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    await db.ingest();
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.close();
  });

  it("backfills mem from a v2 WAL on upgrade", async () => {
    const key = enc.encode("a");
    const value = enc.encode("old");
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(`opfs-lsm-wal/${NAME}`, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("wal", { autoIncrement: true });
        db.createObjectStore("meta");
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const idb = req.result;
        const tx = idb.transaction(["wal", "meta"], "readwrite");
        tx.objectStore("wal").add({
          writerId: "w0",
          ops: [
            {
              type: "put",
              key: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength),
              value: value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength,
              ),
            },
          ],
        });
        tx.oncomplete = () => {
          idb.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    const db = await openDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
    });
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("old");
    await db.close();
  });
});
