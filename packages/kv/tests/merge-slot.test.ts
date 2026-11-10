import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../src/index.js";
import { inMergeSlot } from "../src/host/merge-slot.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { ensureEngine, openMerge, type MergeSpec } from "../src/store/engine.js";
import { __resetMemoryFsForTests, openHarnessDb, type Db } from "../src/testing.js";

const enc = new TextEncoder();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("inMergeSlot", () => {
  it("runs one merge at a time, in the order they asked", async () => {
    const log: string[] = [];
    const merge = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await pause(ms);
      log.push(`${name} end`);
      return name;
    };

    const results = await Promise.all([
      inMergeSlot(merge("a", 20)),
      inMergeSlot(merge("b", 1)),
      inMergeSlot(merge("c", 1)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("passes the turn on when a merge fails", async () => {
    const failed = inMergeSlot(() => Promise.reject(new Error("no space")));
    const next = inMergeSlot(() => Promise.resolve("ran"));

    await expect(failed).rejects.toThrow("no space");
    await expect(next).resolves.toBe("ran");
  });
});

describe("the wasm engine's session", () => {
  const spec: MergeSpec = {
    sources: [[1000]],
    dropTombstones: false,
    targetBytes: 4 * 1024 * 1024,
    codec: "raw",
    chunkBytes: 64 * 1024,
    tailBytes: 64 * 1024,
    yieldBytes: 1024 * 1024,
  };

  it("refuses a second session instead of handing out the TypeScript one", async () => {
    await ensureEngine();
    const first = await openMerge(spec);
    try {
      await expect(openMerge(spec)).rejects.toThrow(/session is open/);
    } finally {
      first.close();
    }
    (await openMerge(spec)).close();
  });
});

const A = "merge-slot-a";
const B = "merge-slot-b";

afterEach(async () => {
  for (const name of [A, B]) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    __resetMemoryFsForTests(name);
  }
});

/** A database over `inner` with its own host. Compaction is the only host work that opens a run. */
async function database(name: string) {
  const inner = new MemoryFs();
  const opened: string[] = [];
  const hold: { create?: (path: string) => Promise<void> } = {};
  const fs: AsyncFs = {
    read: (path, offset, length) => inner.read(path, offset, length),
    open: (path) => {
      opened.push(path);
      return inner.open(path);
    },
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: async (path) => {
      await hold.create?.(path);
      return inner.create(path);
    },
  };
  const host = new EngineHost(() => fs);
  const db = await openHarnessDb({
    name,
    writerId: `${name}-w`,
    fs: inner,
    ingest: createLocalIngestClient(host),
    ingestPolicy: { maxWalBytes: 1e12 },
  });
  let next = 0;
  /** One flush run: a put and an ingest that does not wait for compaction. The fourth one starts a compaction. */
  const flushRun = async () => {
    await db.put(enc.encode(`${name}/k${next}`), enc.encode(`v${next}`));
    next++;
    await host.ingest(name, Number.POSITIVE_INFINITY);
  };
  return { host, db, hold, opened, flushRun };
}

/** Stops the next L1 output of `hold` at its creation, which keeps the merge's session open. */
function stopOutput(hold: { create?: (path: string) => Promise<void> }) {
  const state = { stopped: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  hold.create = async (path) => {
    if (!path.startsWith("l1/")) return;
    hold.create = undefined;
    state.stopped = true;
    await gate;
  };
  return { state, release: () => release() };
}

async function readAll(db: Db, name: string, count: number) {
  const values: (string | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    const value = await db.get(enc.encode(`${name}/k${i}`));
    values.push(value && new TextDecoder().decode(value));
  }
  return values;
}

describe("two databases compacting in one context", () => {
  it("makes the second merge wait for the first, then run it", async () => {
    const a = await database(A);
    const b = await database(B);
    for (let i = 0; i < 3; i++) await a.flushRun();
    const stop = stopOutput(a.hold);
    await a.flushRun();
    await vi.waitFor(() => expect(stop.state.stopped).toBe(true));

    for (let i = 0; i < 4; i++) await b.flushRun();
    await pause(100);
    expect(b.opened).toEqual([]);

    stop.release();
    await vi.waitFor(async () => expect((await b.host.stats(B)).compactionSteps).toBe(1));
    await a.host.ingest(A, Number.POSITIVE_INFINITY, true);

    expect((await a.host.stats(A)).compactionSteps).toBe(1);
    expect(b.opened.length).toBeGreaterThan(0);
    expect(await readAll(a.db, A, 4)).toEqual(["v0", "v1", "v2", "v3"]);
    expect(await readAll(b.db, B, 4)).toEqual(["v0", "v1", "v2", "v3"]);
    await Promise.all([a.db.close(), b.db.close()]);
  });

  it("lets a flush run while a merge holds the slot", async () => {
    const a = await database(A);
    for (let i = 0; i < 3; i++) await a.flushRun();
    const stop = stopOutput(a.hold);
    await a.flushRun();
    await vi.waitFor(() => expect(stop.state.stopped).toBe(true));

    await a.flushRun();

    expect((await a.host.stats(A)).flushes).toBe(5);
    expect((await a.host.stats(A)).compactionSteps).toBe(0);
    stop.release();
    await a.host.ingest(A, Number.POSITIVE_INFINITY, true);
    expect(await readAll(a.db, A, 5)).toEqual(["v0", "v1", "v2", "v3", "v4"]);
    await a.db.close();
  });
});
