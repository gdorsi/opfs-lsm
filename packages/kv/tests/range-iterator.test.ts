import { afterEach, describe, expect, it } from "vitest";
import { ClosedError, ConstraintError, type Db, type Entry } from "../src/index.js";
import { EngineHost, MemoryFs, createLocalIngestClient, ingest, openHarnessDb } from "../src/testing.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const key = (i: number) => utf(`k${String(i).padStart(3, "0")}`);
const ROWS = 40;

/** A MemoryFs whose run reads can be made to fail, or to wait at a gate. */
function faultyFs() {
  const mem = new MemoryFs();
  let failing = false;
  let gate: Promise<void> | undefined;
  let lift = () => {};
  let arrived = () => {};
  const fs: AsyncFs = {
    read: (path, offset, length) => mem.read(path, offset, length),
    open: async (path) => {
      const file = await mem.open(path);
      return (
        file && {
          size: file.size,
          read: async (offset, length) => {
            if (gate) {
              arrived();
              await gate;
            }
            if (failing) throw new Error(`read of ${path} failed`);
            return file.read(offset, length);
          },
          close: () => file.close(),
        }
      );
    },
    list: (dir) => mem.list(dir),
    remove: (path) => mem.remove(path),
    removeUnlessOpen: (path) => mem.removeUnlessOpen(path),
    create: (path) => mem.create(path),
  };
  return {
    fs,
    mem,
    fail(on: boolean) {
      failing = on;
    },
    /** Holds every run read from now on. Resolves once one waits. */
    shut(): Promise<void> {
      gate = new Promise<void>((resolve) => (lift = resolve));
      return new Promise<void>((resolve) => (arrived = resolve));
    },
    lift() {
      gate = undefined;
      lift();
    },
  };
}

const opened: Db[] = [];
let names = 0;

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

/**
 * A database with rows 0..ROWS-1: thirds in three L0 runs, so one more flush
 * starts a compaction, and every fourth row written again in the memtable.
 * `cold` opens a second handle, which has read no run page yet.
 */
async function seeded(cold = false) {
  const folder = faultyFs();
  const options = {
    name: `range-iterator-${names++}`,
    fs: folder.fs,
    ingest: createLocalIngestClient(new EngineHost(() => folder.fs)),
    maxWalBytes: 1e12,
  };
  const writer = await openHarnessDb({ ...options, writerId: "w" });
  opened.push(writer);
  for (let run = 0; run < 3; run++) {
    await writer.batch((tx) => {
      for (let i = run; i < ROWS; i += 3) tx.put(key(i), utf(`run${i}`));
    });
    await ingest(writer);
  }
  await writer.batch((tx) => {
    for (let i = 0; i < ROWS; i += 4) tx.put(key(i), utf(`mem${i}`));
  });
  let db = writer;
  if (cold) {
    db = await openHarnessDb({ ...options, writerId: "r" });
    opened.push(db);
  }
  const l0 = () => folder.mem.publishedPaths().filter((p) => p.startsWith("l0/"));
  return { db, writer, folder, l0, inputs: l0() };
}

const want = Array.from({ length: ROWS }, (_, i) => `${dec.decode(key(i))}=${i % 4 === 0 ? "mem" : "run"}${i}`);
const show = (e: Entry) => `${dec.decode(e.key)}=${dec.decode(e.value)}`;

/** Flushes twice more, so the three L0 runs are compacted away once nothing reads them. */
async function compact(db: Db): Promise<void> {
  await db.put(utf("zz"), utf("late"));
  await ingest(db);
  await ingest(db);
}

type Scan = (db: Db) => Promise<{ it: AsyncIterator<Entry>; finish: () => Promise<unknown> }>;

/** `db.range()`, and `snap.range()` of a view that stays open until `finish` is called. */
const scans: [string, Scan][] = [
  ["db.range", async (db) => ({ it: db.range()[Symbol.asyncIterator](), finish: async () => undefined })],
  [
    "view.range",
    (db) =>
      new Promise((resolve) => {
        let close = () => {};
        const closed = new Promise<void>((r) => (close = r));
        const view = db.view(async (snap) => {
          resolve({ it: snap.range()[Symbol.asyncIterator](), finish: () => (close(), view) });
          await closed;
        });
      }),
  ],
];

describe.each(scans)("%s as an async iterator", (_what, scan) => {
  it("yields every entry in key order, each a fresh entry whose arrays own their buffers", async () => {
    const { db } = await seeded();
    const { it: iter, finish } = await scan(db);
    const got: Entry[] = [];
    for (let r = await iter.next(); !r.done; r = await iter.next()) got.push(r.value);
    await finish();
    expect(got.map(show)).toEqual(want);
    expect(new Set(got).size).toBe(ROWS);
    expect(new Set(got.flatMap((e) => [e.key.buffer, e.value.buffer])).size).toBe(2 * ROWS);
    for (const e of got) {
      for (const b of [e.key, e.value]) expect([b.byteOffset, b.buffer.byteLength]).toEqual([0, b.byteLength]);
    }
  });

  it("is not changed by a caller that overwrites the entries it was given", async () => {
    const { db } = await seeded();
    const { it: iter, finish } = await scan(db);
    const got: string[] = [];
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      got.push(show(r.value));
      r.value.key.fill(0xff);
      r.value.value.fill(0xff);
    }
    await finish();
    expect(got).toEqual(want);
    const again: string[] = [];
    for await (const e of db.range()) again.push(show(e));
    expect(again).toEqual(want);
  });

  it("answers next() calls made without waiting in the order they were made, warm and cold", async () => {
    for (const cold of [false, true]) {
      const { db } = await seeded(cold);
      const { it: iter, finish } = await scan(db);
      const results = await Promise.all(Array.from({ length: ROWS + 3 }, () => iter.next()));
      await finish();
      expect(results.slice(0, ROWS).map((r) => (r.done ? "done" : show(r.value)))).toEqual(want);
      expect(results.slice(ROWS).map((r) => r.done)).toEqual([true, true, true]);
    }
  });

  it("lets go of its runs when it ends, and a second scan keeps them until it ends too", async () => {
    const { db, l0, inputs } = await seeded();
    const first = await scan(db);
    const second = await scan(db);
    await first.it.next();
    await second.it.next();
    await compact(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));

    for (let r = await first.it.next(); !r.done; r = await first.it.next());
    await first.finish();
    await ingest(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));
    expect(show((await second.it.next()).value)).toBe(want[1]);

    for (let r = await second.it.next(); !r.done; r = await second.it.next());
    await second.finish();
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("lets go of its runs when the caller returns early, once however often it returns", async () => {
    const { db, l0, inputs } = await seeded();
    const { it: iter, finish } = await scan(db);
    const other = await scan(db);
    await iter.next();
    await other.it.next();
    await compact(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));

    expect(await iter.return!()).toEqual({ value: undefined, done: true });
    expect(await iter.return!()).toEqual({ value: undefined, done: true });
    expect((await iter.next()).done).toBe(true);
    await finish();
    await ingest(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));

    await other.it.return!();
    await other.finish();
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("runs a return() made while a read waits after that read, and ends every call made after it", async () => {
    const { db, writer, folder, l0, inputs } = await seeded(true);
    const { it: iter, finish } = await scan(db);
    const reached = folder.shut();
    const calls = [iter.next(), iter.return!(), iter.next(), iter.return!()];
    const settled: number[] = [];
    for (const [i, call] of calls.entries()) void call.then(() => settled.push(i));
    await reached;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual([]);
    folder.lift();
    const [first, ...rest] = await Promise.all(calls);
    expect(first!.done ? "done" : show(first!.value)).toBe(want[0]);
    expect(rest).toEqual(Array(3).fill({ value: undefined, done: true }));
    expect(settled).toEqual([0, 1, 2, 3]);
    await finish();
    await db.close();
    await compact(writer);
    await ingest(writer);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("ends on a throw() with the caller's error, lets go of its runs, and is done afterwards", async () => {
    const { db, l0, inputs } = await seeded();
    const { it: iter, finish } = await scan(db);
    await iter.next();
    await compact(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));

    const err = new Error("from the caller");
    await expect(iter.throw!(err)).rejects.toBe(err);
    await expect(iter.throw!(err)).rejects.toBe(err);
    expect((await iter.next()).done).toBe(true);
    await finish();
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("is done after a throw() before the first next(), and took no run", async () => {
    const { db, l0, inputs } = await seeded();
    const { it: iter, finish } = await scan(db);
    const err = new Error("from the caller");
    await expect(iter.throw!(err)).rejects.toBe(err);
    expect((await iter.next()).done).toBe(true);
    await finish();
    await compact(db);
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("passes the error thrown into a generator that delegates to it, and lets go of its runs", async () => {
    const { db, l0, inputs } = await seeded();
    const { it: iter, finish } = await scan(db);
    const outer = (async function* () {
      yield* { [Symbol.asyncIterator]: () => iter };
    })();
    expect(show((await outer.next()).value!)).toBe(want[0]);
    const err = new Error("from the caller");
    await expect(outer.throw(err)).rejects.toBe(err);
    expect((await iter.next()).done).toBe(true);
    await finish();
    await compact(db);
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("inherits what a generator's iterator does: it is its own iterable, and disposing it returns", async () => {
    const { db, l0, inputs } = await seeded();
    const { it: iter, finish } = await scan(db);
    const generated = (async function* () {})();
    const inherited = Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(generated)));
    expect(Object.getPrototypeOf(iter)).toBe(inherited);
    expect((iter as AsyncIterableIterator<Entry>)[Symbol.asyncIterator]()).toBe(iter);

    await iter.next();
    await (iter as unknown as AsyncDisposable)[Symbol.asyncDispose]();
    expect((await iter.next()).done).toBe(true);
    await finish();
    await compact(db);
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("rejects with the read's error, lets go of its runs, and is done afterwards", async () => {
    const { db, writer, folder, l0, inputs } = await seeded(true);
    const { it: iter, finish } = await scan(db);
    folder.fail(true);
    await expect(iter.next()).rejects.toThrow(/read of l0\/.* failed/);
    folder.fail(false);
    expect((await iter.next()).done).toBe(true);
    await finish();
    await db.close();
    await compact(writer);
    await ingest(writer);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("rejects with ClosedError when a read fails after the handle closed", async () => {
    const { db, folder } = await seeded(true);
    const { it: iter, finish } = await scan(db);
    const reached = folder.shut();
    const cut = iter.next();
    await reached;
    folder.fail(true);
    const closing = db.close();
    folder.lift();
    await expect(cut).rejects.toBeInstanceOf(ClosedError);
    await closing;
    await finish().catch(() => undefined);
  });
});

describe("a range iterator and its handle", () => {
  it("rejects the next() after db.close() with ClosedError", async () => {
    const { db } = await seeded();
    const iter = db.range()[Symbol.asyncIterator]();
    expect(show((await iter.next()).value!)).toBe(want[0]);
    await db.close();
    await expect(iter.next()).rejects.toBeInstanceOf(ClosedError);
    expect((await iter.next()).done).toBe(true);
  });

  it("rejects a range that starts after db.close() with ClosedError", async () => {
    const { db } = await seeded();
    const iter = db.range()[Symbol.asyncIterator]();
    await db.close();
    await expect(iter.next()).rejects.toBeInstanceOf(ClosedError);
    expect((await iter.next()).done).toBe(true);
  });

  it("rejects a range whose bound is not a valid key, and is done afterwards", async () => {
    const { db } = await seeded();
    const iter = db.range({ start: new Uint8Array(64 * 1024) })[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(ConstraintError);
    expect((await iter.next()).done).toBe(true);
  });

  it("rejects the next() after its view closed with ClosedError, and lets go of its runs", async () => {
    const { db, l0, inputs } = await seeded();
    const iter = await db.view(async (snap) => {
      const it = snap.range()[Symbol.asyncIterator]();
      expect(show((await it.next()).value!)).toBe(want[0]);
      return { it };
    });
    await compact(db);
    expect(l0()).toEqual(expect.arrayContaining(inputs));
    await expect(iter.it.next()).rejects.toBeInstanceOf(ClosedError);
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });

  it("holds no run when it was never started", async () => {
    const { db, l0, inputs } = await seeded();
    db.range();
    await db.view((snap) => void snap.range());
    await compact(db);
    await ingest(db);
    expect(l0().filter((p) => inputs.includes(p))).toEqual([]);
  });
});

describe("count and rangeJoin over the same scan", () => {
  it("count the entries a range yields, with and without a limit, forward and backward", async () => {
    const { db } = await seeded();
    for (const reverse of [false, true]) {
      for (const limit of [undefined, 0, 1, 7, ROWS, ROWS + 5]) {
        const range = { start: key(3), endExclusive: key(31), reverse, ...(limit === undefined ? {} : { limit }) };
        const yielded: string[] = [];
        for await (const e of db.range(range)) yielded.push(show(e));
        const inBounds = want.slice(3, 31);
        expect(yielded).toEqual((reverse ? [...inBounds].reverse() : inBounds).slice(0, limit));
        expect(await db.count(range)).toBe(yielded.length);
        const viewed = await db.view(async (snap) => ({
          count: await snap.count(range),
          joined: (await snap.rangeJoin(range, (e) => e.key)).map((j) => `${show(j.entry)}|${dec.decode(j.joined!)}`),
        }));
        expect(viewed.count).toBe(yielded.length);
        expect(viewed.joined).toEqual(yielded.map((row) => `${row}|${row.split("=")[1]}`));
      }
    }
  });
});
