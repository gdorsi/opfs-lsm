import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests, ingest, MemoryFs } from "../src/testing.js";
import { TabWal } from "../src/idb/wal.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { publishGeneration } from "../src/host/publish.js";
import { decodeGeneration, manifestHead } from "../src/store/generation.js";
import { asGeneration } from "../src/seq.js";

const NAME = "generation-idb";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const maxWalBytes = 1 << 30;

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function putManifestCopy(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(`opfs-lsm-wal/${NAME}`);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("meta", "readwrite");
      tx.objectStore("meta").put(bytes, "manifest");
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
    };
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => __resetMemoryFsForTests(NAME));

/** The `manifest` value of the WAL database's `meta` store. */
function manifestCopy(): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(`opfs-lsm-wal/${NAME}`);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction("meta").objectStore("meta").get("manifest");
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        open.result.close();
        resolve(get.result as Uint8Array | undefined);
      };
    };
  });
}

function observedFs(inner: MemoryFs) {
  let lists = 0;
  const opened: string[] = [];
  const closed: string[] = [];
  let manifestReads = 0;
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
      if (path.startsWith("m/")) manifestReads += 1;
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
    open: async (path) => {
      opened.push(path);
      const file = await inner.open(path);
      return (
        file && {
          ...file,
          close: () => {
            closed.push(path);
            file.close();
          },
        }
      );
    },
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: (path) => inner.create(path),
  };
  return {
    fs,
    lists: () => lists,
    opened,
    closed,
    manifestReads: () => manifestReads,
    holdNextManifestRead: () => {
      holdNextManifestRead = true;
    },
    isHeld,
    release: () => release(),
  };
}

describe("generation recorded in IndexedDB", () => {
  it("a view pinned before a batch sees none of it after ingest", async () => {
    const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: new MemoryFs(), maxWalBytes });
    await db.put(utf("z"), utf("0"));
    await ingest(db);
    await db.put(utf("a"), utf("1"));

    const seen = await db.view(async (snap) => {
      await db.batch((tx) => {
        tx.put(utf("a"), utf("2"));
        tx.put(utf("b"), utf("2"));
      });
      await ingest(db);
      return [text(await snap.get(utf("a"))), text(await snap.get(utf("b")))];
    });

    expect(seen).toEqual(["1", undefined]);
    expect(text(await db.get(utf("b")))).toBe("2");
    await db.close();
  });

  it("keeps only the recorded generation's manifest and every key reads back", async () => {
    const inner = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    for (let i = 0; i < 6; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await ingest(db);
    }
    expect(await inner.list("m")).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    await db.close();
  });

  it("a get after ingest does not list OPFS", async () => {
    const o = observedFs(new MemoryFs());
    const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: o.fs, maxWalBytes });
    for (let i = 0; i < 20; i++) await db.put(utf(`k${i}`), utf(`v${i}`));
    await ingest(db);
    const before = o.lists();
    for (let i = 0; i < 20; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    expect(o.lists()).toBe(before);
    await db.close();
  });

  it("stores the head of the manifest it records, at a flush and at a compaction", async () => {
    const inner = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    expect(await manifestCopy()).toBeUndefined();
    // Six flushes pass the L0 trigger, so the last recorded generation is a compaction's.
    for (let i = 0; i < 6; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await ingest(db);
      const [file] = await inner.list("m");
      const copy = await manifestCopy();
      const manifest = (await inner.read(`m/${file}`, 0, Number.POSITIVE_INFINITY))!;
      expect(copy).toEqual(manifestHead(manifest));
      expect(decodeGeneration(manifest).generation).toBe(Number(file!.replace(".mft", "")));
    }
    expect((await inner.list("l1")).length).toBeGreaterThan(0);
    await db.close();
  });

  it("a reopen reads the tail once and opens the runs before the manifest file is read", async () => {
    const inner = new MemoryFs();
    const first = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    for (let i = 0; i < 20; i++) await first.put(utf(`k${i}`), utf(`v${i}`));
    await ingest(first);
    await first.put(utf("tail"), utf("t"));
    await first.close();

    const o = observedFs(inner);
    o.holdNextManifestRead();
    const tails = vi.fn<() => void>();
    const open = TabWal.open;
    TabWal.open = async (...args) => {
      const wal = await open(...args);
      const tail = wal.tail;
      wal.tail = (...rest) => {
        tails();
        return tail(...rest);
      };
      return wal;
    };
    const reopening = openHarnessDb({ name: NAME, writerId: "w2", fs: o.fs, maxWalBytes });
    await o.isHeld;
    // The held read can be the one the open starts before IndexedDB answers, so the run opens a moment later.
    await vi.waitFor(() => expect(o.opened).toHaveLength(1));
    o.release();
    const db = await reopening;
    expect(tails).toHaveBeenCalledTimes(1);
    TabWal.open = open;
    expect(text(await db.get(utf("k7")))).toBe("v7");
    expect(text(await db.get(utf("tail")))).toBe("t");
    await db.close();
  });

  /** One run and a WAL tail, closed. */
  const oneRunAndTail = async (): Promise<MemoryFs> => {
    const inner = new MemoryFs();
    const first = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    for (let i = 0; i < 20; i++) await first.put(utf(`k${i}`), utf(`v${i}`));
    await ingest(first);
    await first.put(utf("tail"), utf("t"));
    await first.close();
    return inner;
  };

  /** Holds every `TabWal.open` until `release`, as a cold IndexedDB does. */
  const heldWalOpen = () => {
    const open = TabWal.open;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    TabWal.open = async (...args) => {
      await held;
      return open(...args);
    };
    return () => {
      TabWal.open = open;
      release();
    };
  };

  it("a reopen reads the newest manifest and opens its run while IndexedDB still opens, once", async () => {
    const o = observedFs(await oneRunAndTail());
    const release = heldWalOpen();
    const reopening = openHarnessDb({ name: NAME, writerId: "w2", fs: o.fs, maxWalBytes });
    await vi.waitFor(() => expect(o.opened).toHaveLength(1));
    release();
    const db = await reopening;
    expect(text(await db.get(utf("k7")))).toBe("v7");
    expect(text(await db.get(utf("tail")))).toBe("t");
    expect(o.opened).toHaveLength(1);
    expect(o.manifestReads()).toBe(1);
    expect(o.closed).toEqual([]);
    await db.close();
    expect(o.closed).toEqual(o.opened);
  });

  it("a reopen that ends before its early listing answers opens nothing after", async () => {
    const o = observedFs(await oneRunAndTail());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const fs: AsyncFs = {
      ...o.fs,
      list: async (dir) => {
        if (first) {
          first = false;
          await held;
        }
        return o.fs.list(dir);
      },
    };
    const db = await openHarnessDb({ name: NAME, writerId: "w2", fs, maxWalBytes });
    expect(o.opened).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(o.opened).toHaveLength(1);
    expect(o.manifestReads()).toBe(1);
    expect(text(await db.get(utf("k7")))).toBe("v7");
    await db.close();
    expect(o.closed).toEqual(o.opened);
  });

  it("a reopen closes the run it opened ahead when IndexedDB records another manifest", async () => {
    const inner = await oneRunAndTail();
    const [file] = await inner.list("m");
    const recorded = decodeGeneration((await inner.read(`m/${file}`, 0, Number.POSITIVE_INFINITY))!);
    // A manifest no flush recorded, numbered past the recorded one, over a copy of the run. Recovery keeps the
    // recorded one: this one reaches no further.
    const run = recorded.runs[0]!;
    const copy = await inner.create("l0/copy.sst");
    await copy.write((await inner.read(run.path, 0, Number.POSITIVE_INFINITY))!);
    await copy.finish();
    await publishGeneration(inner, { ...recorded, generation: asGeneration(recorded.generation + 5), runs: [{ ...run, path: "l0/copy.sst" }] });
    const o = observedFs(inner);
    const release = heldWalOpen();
    const reopening = openHarnessDb({ name: NAME, writerId: "w2", fs: o.fs, maxWalBytes });
    await vi.waitFor(() => expect(o.opened).toEqual(["l0/copy.sst"]));
    release();
    const db = await reopening;
    expect(text(await db.get(utf("k7")))).toBe("v7");
    expect(text(await db.get(utf("tail")))).toBe("t");
    await vi.waitFor(() => expect(o.closed).toEqual(["l0/copy.sst"]));
    expect(o.opened).toEqual(["l0/copy.sst", run.path]);
    await db.close();
    expect(o.closed).toEqual(["l0/copy.sst", run.path]);
  });

  it("a reopen whose early read met a manifest still being written reads it again", async () => {
    const inner = await oneRunAndTail();
    let early = true;
    // The first read of the manifest file finds it created and not closed yet, as during a flush.
    const fs: AsyncFs = {
      read: async (path, offset, length) => {
        if (early && path.startsWith("m/")) {
          early = false;
          return new Uint8Array(0);
        }
        return inner.read(path, offset, length);
      },
      list: (dir) => inner.list(dir),
      remove: (path) => inner.remove(path),
      open: (path) => inner.open(path),
      removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
      create: (path) => inner.create(path),
    };
    const release = heldWalOpen();
    const reopening = openHarnessDb({ name: NAME, writerId: "w2", fs, maxWalBytes });
    await vi.waitFor(() => expect(early).toBe(false));
    release();
    const db = await reopening;
    expect(text(await db.get(utf("k7")))).toBe("v7");
    expect(text(await db.get(utf("tail")))).toBe("t");
    await db.close();
  });

  it("a reopen that fails closes the run it opened ahead", async () => {
    const o = observedFs(await oneRunAndTail());
    const open = TabWal.open;
    TabWal.open = async () => {
      await vi.waitFor(() => expect(o.opened).toHaveLength(1));
      throw new Error("no IndexedDB");
    };
    await expect(openHarnessDb({ name: NAME, writerId: "w2", fs: o.fs, maxWalBytes })).rejects.toThrow("no IndexedDB");
    TabWal.open = open;
    await vi.waitFor(() => expect(o.closed).toEqual(o.opened));
  });

  /** A database of one run holding `a`, closed, with byte `at` of its manifest file changed. `at` counts from the end when negative. */
  const damagedManifest = async (at: number): Promise<MemoryFs> => {
    const inner = new MemoryFs();
    const first = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    await first.put(utf("a"), utf("1"));
    await ingest(first);
    await first.close();
    const [file] = await inner.list("m");
    const damaged = (await inner.read(`m/${file}`, 0, Number.POSITIVE_INFINITY))!.slice();
    damaged[at < 0 ? damaged.length + at : at]! ^= 0xff;
    const w = await inner.create(`m/${file}`);
    await w.write(damaged);
    await w.finish();
    return inner;
  };

  it("a reopen refuses a manifest file whose head does not decode, though the copy does", async () => {
    const inner = await damagedManifest(8);
    await expect(openHarnessDb({ name: NAME, writerId: "w2", fs: inner, maxWalBytes })).rejects.toThrow(CorruptDatabaseError);
  });

  it("a reopen takes a manifest file with a damaged block index, and a read of that run fails", async () => {
    const inner = await damagedManifest(-1);
    const db = await openHarnessDb({ name: NAME, writerId: "w2", fs: inner, maxWalBytes });
    await expect(db.get(utf("a"))).rejects.toThrow(CorruptDatabaseError);
    await db.close();
  });

  it("a reopen reads the manifest file when the copy is another generation's", async () => {
    const inner = new MemoryFs();
    const first = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    await first.put(utf("a"), utf("1"));
    await ingest(first);
    const stale = await manifestCopy();
    await first.put(utf("b"), utf("2"));
    await ingest(first);
    await first.close();
    await putManifestCopy(stale!);

    const db = await openHarnessDb({ name: NAME, writerId: "w2", fs: inner, maxWalBytes });
    expect(text(await db.get(utf("a")))).toBe("1");
    expect(text(await db.get(utf("b")))).toBe("2");
    await db.close();
  });

  it("a reopen reads the manifest file when the copy does not decode", async () => {
    const inner = new MemoryFs();
    const first = await openHarnessDb({ name: NAME, writerId: "w1", fs: inner, maxWalBytes });
    await first.put(utf("a"), utf("1"));
    await ingest(first);
    await first.close();
    const damaged = (await manifestCopy())!.slice();
    damaged[damaged.length - 1]! ^= 0xff;
    await putManifestCopy(damaged);

    const db = await openHarnessDb({ name: NAME, writerId: "w2", fs: inner, maxWalBytes });
    expect(text(await db.get(utf("a")))).toBe("1");
    await db.close();
  });
});
