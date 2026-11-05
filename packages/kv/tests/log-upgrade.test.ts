import { afterEach, beforeEach, expect, it } from "vitest";
import {
  MemoryFs
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";

const NAME = "log-upgrade";
const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (s: string) => enc.encode(s).buffer as ArrayBuffer;

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
afterEach(() => __resetMemoryFsForTests(NAME));

function seedV4(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opfs-lsm-wal/${NAME}`, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      const wal = db.createObjectStore("wal", { autoIncrement: true });
      const meta = db.createObjectStore("meta");
      db.createObjectStore("mem");
      wal.add({ writerId: "old", ops: [{ type: "put", key: buf("gone"), value: buf("x") }] });
      wal.add({ writerId: "old", ops: [{ type: "put", key: buf("a"), value: buf("1") }] });
      wal.add({
        writerId: "old",
        ops: [
          { type: "put", key: buf("a"), value: buf("2") },
          { type: "del", key: buf("b") },
        ],
      });
      meta.put(1, "ingestedThrough");
      meta.put(0, "generation");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

it("a v4 database keeps its uningested writes and continues the seq after upgrade", async () => {
  await seedV4();
  const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: new MemoryFs(), forceMemory: true });
  expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
  expect(await db.get(enc.encode("b"))).toBeUndefined();
  expect(await db.get(enc.encode("gone"))).toBeUndefined();
  await db.put(enc.encode("c"), enc.encode("3"));
  expect(await db.view((snap) => snap.walHead)).toBe(4);
  await db.close();
});

function seedV5(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opfs-lsm-wal/${NAME}`, 5);
    req.onupgradeneeded = () => {
      const db = req.result;
      const meta = db.createObjectStore("meta");
      const mem = db.createObjectStore("mem");
      mem.createIndex("bySeq", "seq");
      mem.put({ seq: 1, kind: "put", value: buf("x"), at: 0 }, buf("gone"));
      mem.put({ seq: 3, kind: "put", value: buf("2"), at: 0 }, buf("a"));
      mem.put({ seq: 3, kind: "del", at: 0 }, buf("b"));
      meta.put(3, "head");
      meta.put(1, "ingestedThrough");
      meta.put(0, "generation");
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

it("a v5 database keeps its uningested rows and stays writable after upgrade", async () => {
  await seedV5();
  const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: new MemoryFs(), forceMemory: true });
  expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
  expect(await db.get(enc.encode("b"))).toBeUndefined();
  expect(await db.get(enc.encode("gone"))).toBeUndefined();
  await db.put(enc.encode("c"), enc.encode("3"));
  expect(dec.decode((await db.get(enc.encode("c")))!)).toBe("3");
  await db.ingest();
  expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
  await db.close();
});
