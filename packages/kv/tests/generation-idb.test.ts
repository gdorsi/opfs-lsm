import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs, __resetMemoryFsForTests, openDb } from "../src/index.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";

const NAME = "generation-idb";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const quiet = { maxBatches: 1e9, maxBytes: 1 << 30 };

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

function observedFs(inner: MemoryFs) {
  let lists = 0;
  let holdNextManifestRead = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markHeld!: () => void;
  const isHeld = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const fs: AsyncFs = {
    async read(path, offset, length) {
      const bytes = await inner.read(path, offset, length);
      if (holdNextManifestRead && path.startsWith("m/")) {
        holdNextManifestRead = false;
        markHeld();
        await held;
      }
      return bytes;
    },
    async list(dir) {
      lists += 1;
      return inner.list(dir);
    },
    remove: (path) => inner.remove(path),
    create: (path) => inner.create(path),
  };
  return {
    fs,
    lists: () => lists,
    holdNextManifestRead: () => {
      holdNextManifestRead = true;
    },
    isHeld,
    release: () => release(),
  };
}

describe("generation recorded in IndexedDB", () => {
  it("a view pinned before a batch sees none of it after ingest", async () => {
    const db = await openDb({ name: NAME, writerId: "w1", fs: new MemoryFs(), ingestPolicy: quiet });
    await db.put(utf("z"), utf("0"));
    await db.ingest();
    await db.put(utf("a"), utf("1"));

    const seen = await db.view(async (snap) => {
      await db.batch((tx) => {
        tx.put(utf("a"), utf("2"));
        tx.put(utf("b"), utf("2"));
      });
      await db.ingest();
      return [text(await snap.get(utf("a"))), text(await snap.get(utf("b")))];
    });

    expect(seen).toEqual(["1", undefined]);
    expect(text(await db.get(utf("b")))).toBe("2");
    await db.close();
  });

  it("keeps only the recorded generation's manifest and every key reads back", async () => {
    const inner = new MemoryFs();
    const db = await openDb({ name: NAME, writerId: "w1", fs: inner, ingestPolicy: quiet });
    for (let i = 0; i < 6; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.ingest();
    }
    expect(await inner.list("m")).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    await db.close();
  });

  it("a get after ingest does not list OPFS", async () => {
    const o = observedFs(new MemoryFs());
    const db = await openDb({ name: NAME, writerId: "w1", fs: o.fs, ingestPolicy: quiet });
    for (let i = 0; i < 20; i++) await db.put(utf(`k${i}`), utf(`v${i}`));
    await db.ingest();
    const before = o.lists();
    for (let i = 0; i < 20; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    expect(o.lists()).toBe(before);
    await db.close();
  });
});
