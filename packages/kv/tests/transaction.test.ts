import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  MemoryFs,
  __resetMemoryFsForTests,
  openDb,
} from "../src/index.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const dec = new TextDecoder();

async function deleteIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await deleteIdb("txn");
  __resetMemoryFsForTests("txn");
});

describe("transaction OCC", () => {
  it("read-modify-write commits", async () => {
    const fs = new MemoryFs();
    const db = await openDb({
      name: "txn",
      writerId: "w1",
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30 },
    });
    await db.put(utf("n"), utf("1"));
    await db.transaction(async (tx) => {
      const cur = await tx.get(utf("n"));
      const n = Number(dec.decode(cur!)) + 1;
      tx.put(utf("n"), utf(String(n)));
    });
    expect(dec.decode((await db.get(utf("n")))!)).toBe("2");
    await db.close();
  });

  it("conflicts when another writer touches a read key", async () => {
    const fs = new MemoryFs();
    const a = await openDb({
      name: "txn",
      writerId: "w1",
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30 },
    });
    const b = await openDb({
      name: "txn",
      writerId: "w2",
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30 },
    });
    await a.put(utf("k"), utf("a"));

    let proceed!: () => void;
    const gate = new Promise<void>((r) => {
      proceed = r;
    });

    const t1 = a.transaction(async (tx) => {
      await tx.get(utf("k"));
      await gate;
      tx.put(utf("k"), utf("from-a"));
    });

    // Concurrent write after A's snapshot
    await b.put(utf("k"), utf("from-b"));
    proceed();

    await expect(t1).rejects.toBeInstanceOf(ConflictError);
    expect(dec.decode((await a.get(utf("k")))!)).toBe("from-b");
    await a.close();
    await b.close();
  });

  it("reads an ingested key and commits on top of it", async () => {
    const db = await openDb({
      name: "txn",
      writerId: "w1",
      fs: new MemoryFs(),
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30 },
    });
    await db.put(utf("n"), utf("1"));
    await db.ingest();
    await db.transaction(async (tx) => {
      const cur = await tx.get(utf("n"));
      tx.put(utf("n"), utf(String(Number(dec.decode(cur!)) + 1)));
    });
    expect(dec.decode((await db.get(utf("n")))!)).toBe("2");
    await db.close();
  });

  it("conflicts when another writer touches a written key", async () => {
    const fs = new MemoryFs();
    const policy = { maxBatches: 10_000, maxBytes: 1 << 30 };
    const a = await openDb({ name: "txn", writerId: "w1", fs, forceMemory: true, ingestPolicy: policy });
    const b = await openDb({ name: "txn", writerId: "w2", fs, forceMemory: true, ingestPolicy: policy });

    let proceed!: () => void;
    const gate = new Promise<void>((r) => {
      proceed = r;
    });
    const t1 = a.transaction(async (tx) => {
      tx.put(utf("k"), utf("from-a"));
      await gate;
    });
    await b.put(utf("k"), utf("from-b"));
    proceed();

    await expect(t1).rejects.toBeInstanceOf(ConflictError);
    expect(dec.decode((await a.get(utf("k")))!)).toBe("from-b");
    await a.close();
    await b.close();
  });

  it("conflicts when the other writer's row was ingested before commit", async () => {
    const fs = new MemoryFs();
    const policy = { maxBatches: 10_000, maxBytes: 1 << 30 };
    const a = await openDb({ name: "txn", writerId: "w1", fs, forceMemory: true, ingestPolicy: policy });
    const b = await openDb({ name: "txn", writerId: "w2", fs, forceMemory: true, ingestPolicy: policy });
    await a.put(utf("k"), utf("a"));

    let proceed!: () => void;
    const gate = new Promise<void>((r) => {
      proceed = r;
    });
    const t1 = a.transaction(async (tx) => {
      await tx.get(utf("k"));
      await gate;
      tx.put(utf("k"), utf("from-a"));
    });
    await b.put(utf("k"), utf("from-b"));
    await b.ingest();
    proceed();

    await expect(t1).rejects.toBeInstanceOf(ConflictError);
    expect(dec.decode((await a.get(utf("k")))!)).toBe("from-b");
    await a.close();
    await b.close();
  });

  it("a long txn commits across an ingest that did not touch its keys", async () => {
    const fs = new MemoryFs();
    const policy = { maxBatches: 10_000, maxBytes: 1 << 30 };
    const db = await openDb({ name: "txn", writerId: "w1", fs, forceMemory: true, ingestPolicy: policy });
    await db.put(utf("x"), utf("0"));

    let proceed!: () => void;
    const gate = new Promise<void>((r) => {
      proceed = r;
    });
    const old = db.transaction(async (tx) => {
      await tx.get(utf("x"));
      await gate;
      tx.put(utf("x"), utf("old"));
    });
    await db.put(utf("y"), utf("1"));
    await db.ingest();
    proceed();
    await old;
    expect(dec.decode((await db.get(utf("x")))!)).toBe("old");
    await db.close();
  });

  it("conflicts when the competing delete's tombstone was compacted away", async () => {
    const fs = new MemoryFs();
    const policy = { maxBatches: 10_000, maxBytes: 1 << 30 };
    const db = await openDb({ name: "txn", writerId: "w1", fs, forceMemory: true, ingestPolicy: policy });
    await db.put(utf("x"), utf("0"));
    await db.ingest();

    let proceed!: () => void;
    const gate = new Promise<void>((r) => {
      proceed = r;
    });
    const old = db.transaction(async (tx) => {
      await tx.get(utf("x"));
      await gate;
      tx.put(utf("x"), utf("old"));
    });
    await db.delete(utf("x"));
    for (let i = 0; i < 4; i++) {
      await db.put(utf(`pad${i}`), utf("p"));
      await db.ingest();
    }
    expect(await fs.list("l1")).toHaveLength(1);
    proceed();
    await expect(old).rejects.toBeInstanceOf(ConflictError);
    expect(await db.get(utf("x"))).toBeUndefined();
    await db.close();
  });

  it("abort discards buffered writes", async () => {
    const fs = new MemoryFs();
    const db = await openDb({
      name: "txn",
      writerId: "w1",
      fs,
      forceMemory: true,
      ingestPolicy: { maxBatches: 10_000, maxBytes: 1 << 30 },
    });
    await db.put(utf("k"), utf("keep"));
    await db.transaction(async (tx) => {
      tx.put(utf("k"), utf("nope"));
      tx.abort();
    });
    expect(dec.decode((await db.get(utf("k")))!)).toBe("keep");
    await db.close();
  });
});
