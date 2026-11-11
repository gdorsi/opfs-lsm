import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDbName, checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { ingestChunk } from "../src/host/ingest.js";
import { IdBWal } from "../src/idb/wal.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { decodeGeneration } from "../src/store/generation.js";
import {
  __resetMemoryFsForTests,
  openHarnessDb,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../src/testing.js";
import { decodeSst } from "../src/store/engine.js";

const NAME = "bounded-flush";
const enc = new TextEncoder();
const dec = new TextDecoder();

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

/** A 4-byte key, so `value(i, n)` makes the put `n` op bytes. */
const keyName = (i: number) => `k${String(i).padStart(3, "0")}`;
const key = (i: number) => enc.encode(keyName(i));
const value = (i: number, opBytes: number) => new Uint8Array(opBytes - 4).fill(i + 1);

type Published = { path: string; bytes: Uint8Array };

/**
 * The host's view of `inner`. It records every file the host publishes and
 * can hold back a create or an open, to stop the host at a chosen point.
 * Compaction is the only host work that opens a run.
 */
function hostFs(inner: MemoryFs) {
  const published: Published[] = [];
  const hold: {
    create?: ((path: string) => Promise<void>) | undefined;
    open?: ((path: string) => Promise<void>) | undefined;
  } = {};
  const fs: AsyncFs = {
    read: (path, offset, length) => inner.read(path, offset, length),
    open: async (path) => {
      await hold.open?.(path);
      return inner.open(path);
    },
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: async (path) => {
      await hold.create?.(path);
      const writer = await inner.create(path);
      return {
        write: (bytes) => writer.write(bytes),
        abort: () => writer.abort(),
        finish: async () => {
          await writer.finish();
          published.push({ path, bytes: (await inner.read(path, 0, Number.POSITIVE_INFINITY))! });
        },
      };
    },
  };
  return { fs, published, hold };
}

async function setup(flushRunBytes: number, l0StopRuns?: number) {
  const inner = new MemoryFs();
  const { fs, published, hold } = hostFs(inner);
  const limits = l0StopRuns === undefined ? { flushRunBytes } : { flushRunBytes, l0StopRuns };
  const host = new EngineHost(() => fs, limits);
  const db = await openHarnessDb({
    name: NAME,
    writerId: "w1",
    fs: inner,
    ingest: createLocalIngestClient(host),
    maxWalBytes: 1e12,
  });
  return { inner, host, db, published, hold };
}

/** Each L0 run the host published, in order: its keys and its op bytes. */
async function l0Runs(published: readonly Published[]) {
  const runs: { keys: string[]; opBytes: number }[] = [];
  for (const { path, bytes } of published) {
    if (!path.startsWith("l0/")) continue;
    const entries = await decodeSst(bytes);
    runs.push({
      keys: entries.map((e) => dec.decode(e.key)),
      opBytes: entries.reduce((n, e) => n + e.key.byteLength + (e.kind === "put" ? e.value.byteLength : 0), 0),
    });
  }
  return runs;
}

async function walMeta() {
  const wal = await IdBWal.open(checkDbName(NAME));
  try {
    return await wal.meta();
  } finally {
    wal.close();
  }
}

/** Resolves once `hold.create` has stopped the next L0 run; `release` lets it go. */
function stopNextL0(hold: ReturnType<typeof hostFs>["hold"]) {
  const state = { stopped: false };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  hold.create = async (path) => {
    if (!path.startsWith("l0/")) return;
    hold.create = undefined;
    state.stopped = true;
    await gate;
  };
  return { state, release: () => release() };
}

describe("a flush of a large backlog", () => {
  it("publishes several L0 runs, each within flushRunBytes, and keeps the newest write of a key", async () => {
    const { db, host, inner, published } = await setup(1050);
    for (let i = 0; i < 23; i++) await db.put(key(i), value(i, 100));
    await db.put(key(0), value(50, 100));
    await db.delete(key(1));

    await ingest(db);

    const runs = await l0Runs(published);
    expect(runs.map((r) => r.keys.length)).toEqual([10, 10, 5]);
    expect(runs.every((r) => r.opBytes <= 1050)).toBe(true);
    expect((await host.stats(NAME)).flushes).toBe(3);
    expect((await walMeta()).ingestedThrough).toBe(25);

    // A tab that opens now reads only the runs, so their order is what it sees.
    const fresh = await openHarnessDb({
      name: NAME,
      writerId: "w2",
      fs: inner,
      ingest: createLocalIngestClient(host),
      maxWalBytes: 1e12,
    });
    expect(await fresh.get(key(0))).toEqual(value(50, 100));
    expect(await fresh.get(key(1))).toBeUndefined();
    expect(await fresh.get(key(22))).toEqual(value(22, 100));
    await Promise.all([db.close(), fresh.close()]);
  });

  it("flushes a record larger than the cap in a run of its own", async () => {
    const { db, host, published } = await setup(200);
    await db.put(key(0), value(0, 50));
    await db.put(key(1), value(1, 600));
    await db.put(key(2), value(2, 50));
    await db.put(key(3), value(3, 50));

    await host.ingest(NAME, Number.POSITIVE_INFINITY);

    const runs = await l0Runs(published);
    expect(runs.map((r) => r.keys)).toEqual([[keyName(0)], [keyName(1)], [keyName(2), keyName(3)]]);
    await db.close();
  });

  it("stops after the chunk that reaches `through`", async () => {
    const { db, host } = await setup(350);
    for (let i = 0; i < 9; i++) await db.put(key(i), value(i, 100));

    await host.ingest(NAME, 4);

    expect((await walMeta()).ingestedThrough).toBe(6);
    expect((await host.stats(NAME)).flushes).toBe(2);
    await db.close();
  });

  it("leaves records acked after it started for the next flush", async () => {
    const { db, host, hold } = await setup(350);
    for (let i = 0; i < 9; i++) await db.put(key(i), value(i, 100));
    const first = stopNextL0(hold);

    const flush = host.ingest(NAME, Number.POSITIVE_INFINITY);
    await vi.waitFor(() => expect(first.state.stopped).toBe(true));
    for (let i = 9; i < 18; i++) await db.put(key(i), value(i, 100));
    first.release();
    await flush;

    expect(await walMeta()).toMatchObject({ head: 18, ingestedThrough: 9 });
    await host.ingest(NAME, Number.POSITIVE_INFINITY);
    expect(await walMeta()).toMatchObject({ head: 18, ingestedThrough: 18 });
    await db.close();
  });

  it("makes a flush asked for meanwhile wait until it ends", async () => {
    const { db, host, hold } = await setup(350);
    for (let i = 0; i < 9; i++) await db.put(key(i), value(i, 100));
    const first = stopNextL0(hold);
    let firstEnded = false;
    const flush = host.ingest(NAME, Number.POSITIVE_INFINITY).then(() => (firstEnded = true));
    await vi.waitFor(() => expect(first.state.stopped).toBe(true));

    // Asks for nothing new. It must still come back after the flush in flight, not between its runs.
    const next = host.ingest(NAME, 0);
    first.release();
    await next;
    expect(firstEnded).toBe(true);
    await flush;
    await db.close();
  });

  it("lets a compaction install land between two chunks", async () => {
    const { db, host, hold, published } = await setup(350);
    let merging = false;
    let releaseMerge!: () => void;
    const mergeGate = new Promise<void>((r) => (releaseMerge = r));
    hold.open = async (path) => {
      if (!path.endsWith(".sst")) return;
      merging = true;
      await mergeGate;
    };
    // The fourth L0 run starts a merge of the four, which stops at its first open.
    for (let i = 0; i < 4; i++) {
      await db.put(key(i), value(i, 100));
      await host.ingest(NAME, Number.POSITIVE_INFINITY);
    }
    await vi.waitFor(() => expect(merging).toBe(true));

    for (let i = 4; i < 13; i++) await db.put(key(i), value(i, 100));
    const first = stopNextL0(hold);
    const flush = host.ingest(NAME, Number.POSITIVE_INFINITY);
    await vi.waitFor(() => expect(first.state.stopped).toBe(true));

    // The merge ends while the first chunk holds the ingest section, so its install queues behind it.
    releaseMerge();
    await vi.waitFor(() => expect(published.some((p) => p.path.startsWith("l1/"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.release();
    await flush;

    const generations = published
      .filter((p) => p.path.startsWith("m/"))
      .map((p) => decodeGeneration(p.bytes));
    const l0Count = (g: (typeof generations)[number]) =>
      g.runs.filter((r) => r.path.startsWith("l0/")).length;
    const install = generations.findIndex((g) => g.runs.some((r) => r.path.startsWith("l1/")));
    // The first chunk made five L0 runs, the install took four of them, two chunks followed.
    expect(generations.slice(install - 1).map(l0Count)).toEqual([5, 1, 2, 3]);

    await ingest(db);
    for (let i = 0; i < 13; i++) expect(await db.get(key(i))).toEqual(value(i, 100));
    await db.close();
  });
});

describe("a flush with L0 full", () => {
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Four one-record flushes leave four L0 runs. Their merge stops at its first open until `release`. */
  async function fullL0(t: Setup) {
    let merging = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.hold.open = async (path) => {
      if (!path.endsWith(".sst")) return;
      merging = true;
      await gate;
    };
    for (let i = 0; i < 4; i++) {
      await t.db.put(key(i), value(i, 100));
      await t.host.ingest(NAME, Number.POSITIVE_INFINITY);
    }
    await vi.waitFor(() => expect(merging).toBe(true));
    return () => release();
  }

  const l0Count = (g: ReturnType<typeof decodeGeneration>) =>
    g.runs.filter((r) => r.path.startsWith("l0/")).length;

  it("publishes no more runs until a compaction step installs", async () => {
    const t = await setup(350, 4);
    const releaseMerge = await fullL0(t);
    await t.db.put(key(4), value(4, 100));
    let flushed = false;
    const flush = t.host.ingest(NAME, Number.POSITIVE_INFINITY).then(() => (flushed = true));

    await vi.waitFor(async () => expect((await t.host.stats(NAME)).l0Stops).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    expect(await l0Runs(t.published)).toHaveLength(4);

    releaseMerge();
    await flush;
    const generations = t.published
      .filter((p) => p.path.startsWith("m/"))
      .map((p) => decodeGeneration(p.bytes));
    const install = generations.findIndex((g) => g.runs.some((r) => r.path.startsWith("l1/")));
    // The install took the four runs, and the fifth record became the one run after it.
    expect(generations.slice(install).map(l0Count)).toEqual([0, 1]);
    expect((await t.host.stats(NAME)).l0Stops).toBe(1);
    await ingest(t.db);
    for (let i = 0; i < 5; i++) expect(await t.db.get(key(i))).toEqual(value(i, 100));
    await t.db.close();
  });

  it("goes on when no compaction can run", async () => {
    // Two runs are below the four that start a merge, so no step will ever install.
    const t = await setup(350, 2);
    for (let i = 0; i < 4; i++) {
      await t.db.put(key(i), value(i, 100));
      await t.host.ingest(NAME, Number.POSITIVE_INFINITY);
    }
    expect(await l0Runs(t.published)).toHaveLength(4);
    expect((await t.host.stats(NAME)).l0Stops).toBe(2);
    await t.db.close();
  });

  it("goes on when the compaction it waits for fails", async () => {
    const t = await setup(350, 4);
    t.hold.create = async (path) => {
      if (path.startsWith("l1/")) throw new Error("disk full");
    };
    for (let i = 0; i < 4; i++) {
      await t.db.put(key(i), value(i, 100));
      await t.host.ingest(NAME, Number.POSITIVE_INFINITY);
    }
    await t.db.put(key(4), value(4, 100));
    await t.host.ingest(NAME, Number.POSITIVE_INFINITY);
    expect(await l0Runs(t.published)).toHaveLength(5);
    expect((await t.host.stats(NAME)).l0Stops).toBeGreaterThanOrEqual(1);
    await t.db.close();
  });

  it("ingestChunk stops with records waiting, and is empty with none", async () => {
    const fs = new MemoryFs();
    const wal = await IdBWal.open(checkDbName(NAME));
    try {
      const put = (i: number): CheckedOp[] => [
        { type: "put", key: checkKey(key(i)), value: checkValue(value(i, 100)) },
      ];
      for (let i = 0; i < 3; i++) await wal.append(put(i));
      // 100 op bytes a record and a cap of 100: one record a run.
      const limits = { maxBytes: 100, l0Stop: 2 };
      const chunk = (through: number) => ingestChunk(wal, fs, through, undefined, limits);

      expect((await chunk(3)).kind).toBe("folded");
      expect((await chunk(3)).kind).toBe("folded");
      const stopped = await chunk(3);
      expect(stopped).toMatchObject({ kind: "stopped", ingestedThrough: 2, foldedBytes: 0 });
      expect(fs.publishedPaths().filter((p) => p.startsWith("l0/"))).toHaveLength(2);
      expect(await wal.getIngestedThrough()).toBe(2);
      // L0 is still full, but nothing through 2 is waiting.
      expect((await chunk(2)).kind).toBe("empty");
    } finally {
      wal.close();
    }
  });
});
