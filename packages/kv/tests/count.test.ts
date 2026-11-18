import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { ConstraintError, type Db, type Range } from "../src/index.js";
import { untilHit } from "../src/store/cursor.js";
import { encodeRun, ensureEngine } from "../src/store/engine.js";
import { Memtable, tallyRows } from "../src/store/memtable.js";
import { PageCache } from "../src/store/page-cache.js";
import { liveCount, RunLevel } from "../src/store/read.js";
import { SstReader } from "../src/store/sst-reader.js";
import { Sum, type SstEntry, type Was } from "../src/store/sst.js";
import { __resetMemoryFsForTests, ingest, MemoryFs, openHarnessDb, readStats, settle } from "../src/testing.js";
import { checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { asSeq } from "../src/seq.js";
import { decodeSst, encodeSstRef, sstKeyRange, tallyOf } from "./oracle/sst-ref.js";
import { bytesFile, collect } from "./runs.js";

const NAME = "count-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const key = (i: number) => utf(`k${String(i).padStart(5, "0")}`);

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

/** xorshift32: seedable, so a failure replays. */
function rng(seed: number): (n: number) => number {
  let x = seed | 1;
  return (n) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
}

describe("a run's tally", () => {
  beforeAll(async () => {
    await ensureEngine();
  });

  /** 3,000 keys whose records say every one of the six things a record can say. */
  function entries(): SstEntry[] {
    const said: (Was | undefined)[] = ["absent", "present", undefined];
    return Array.from({ length: 3_000 }, (_, i) => {
      const was = said[(i * 7) % 3 === 0 && i % 50 < 2 ? 2 : i % 2];
      return i % 5 === 0
        ? { kind: "del" as const, key: key(i * 2), seq: asSeq(i + 1), was }
        : { kind: "put" as const, key: key(i * 2), value: utf("v".repeat(i % 90)), seq: asSeq(i + 1), was };
    });
  }

  it("is what the records in the bounds say, for any bounds, raw or LZ4, and reads at most two blocks", async () => {
    const all = entries();
    const pick = rng(7);
    for (const body of [encodeSstRef(all), (await encodeRun(all, "lz4")).body]) {
      const decoded = decodeSst(body);
      let reads = 0;
      const file = bytesFile(body);
      const reader = new SstReader({ size: file.size, read: (o, n) => (reads++, file.read(o, n)) }, new PageCache(), sstKeyRange(body));
      // The layout, once.
      await untilHit(() => reader.tally(undefined, new Sum()) ?? true);
      for (let i = 0; i < 300; i++) {
        const [a, b] = [pick(6_200), pick(6_200)].sort((x, y) => x - y) as [number, number];
        const bounds = i === 0 ? undefined : { ...(i % 5 ? { start: key(a) } : {}), ...(i % 7 ? { endExclusive: key(b + 1) } : {}) };
        const inside = decoded.filter(
          (e) => (!bounds?.start || compareBytes(e.key, bounds.start) >= 0) && (!bounds?.endExclusive || compareBytes(e.key, bounds.endExclusive) < 0),
        );
        const cold = new SstReader({ size: file.size, read: (o, n) => (reads++, file.read(o, n)) }, new PageCache(), sstKeyRange(body));
        await untilHit(() => cold.tally(undefined, new Sum()) ?? true);
        reads = 0;
        const sum = await untilHit(() => {
          const s = new Sum();
          return cold.tally(bounds, s) ?? s;
        });
        expect({ plus: sum.plus, minus: sum.minus, unknown: sum.unknown }, `bounds ${i}`).toEqual(tallyOf(inside));
        expect(reads, `bounds ${i}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("is the run's totals when the bounds hold the whole run, with no read", async () => {
    const all = entries().map((e) => ({ ...e, was: e.was ?? ("present" as const) }));
    const run = await encodeRun(all, "raw");
    expect(run.end.tally).toEqual(tallyOf(all));
    const reader = new SstReader(
      { size: run.body.byteLength, read: () => Promise.reject(new Error("a whole run is counted from the manifest")) },
      new PageCache(),
      run.end.range,
      undefined,
      run.end.tally,
    );
    const sum = new Sum();
    expect(new RunLevel([reader]).tally({ start: utf("a"), endExclusive: utf("z") }, sum)).toBeUndefined();
    expect({ plus: sum.plus, minus: sum.minus, unknown: sum.unknown }).toEqual(tallyOf(all));
  });
});

describe("a memtable row says what held before the oldest record it folds", () => {
  const put = (k: string, was?: Was): CheckedOp => ({ type: "put", key: checkKey(utf(k)), value: checkValue(utf("v")), was });
  const del = (k: string, was?: Was): CheckedOp => ({ type: "del", key: checkKey(utf(k)), was });
  const said = (mem: Memtable) => {
    const sum = new Sum();
    tallyRows(mem.range(), sum);
    return { plus: sum.plus, minus: sum.minus, unknown: sum.unknown };
  };
  const apply = (mem: Memtable, ...records: CheckedOp[][]) => {
    for (const ops of records) mem.apply({ seq: asSeq(mem.appliedThrough + 1), ops });
  };

  it("an insert and its updates are one insert, an insert and its delete change nothing", () => {
    const mem = new Memtable();
    apply(mem, [put("a", "absent"), put("b", "absent")], [put("a", "present")], [del("b", "present")], [put("c", "present")], [del("d", "present")]);
    expect(said(mem)).toEqual({ plus: 1, minus: 1, unknown: 0 });
    expect(mem.get(utf("a"))).toMatchObject({ kind: "put", was: "absent", seq: 2 });
    expect(mem.get(utf("b"))).toMatchObject({ kind: "del", was: "absent", seq: 3 });
  });

  it("a blind write says nothing, and a write over a row it holds knows what it replaces", () => {
    const mem = new Memtable();
    apply(mem, [put("a")], [put("a", "absent")], [put("b", "absent")], [del("b")], [put("b")]);
    // "a" was blind first, so nobody knows what held before it. "b" is known all the way.
    expect(mem.get(utf("a"))!.was).toBeUndefined();
    expect(mem.get(utf("b"))).toMatchObject({ kind: "put", was: "absent" });
    expect(said(mem)).toEqual({ plus: 1, minus: 0, unknown: 1 });
  });

  it("once a run holds the oldest records, the row says what held before the oldest one left", () => {
    const mem = new Memtable();
    // seq 1 inserts, seq 2 deletes, seq 3 inserts again, seq 4 updates.
    apply(mem, [put("a", "absent")], [del("a", "present")], [put("a", "absent")], [put("a", "present")]);
    expect(mem.get(utf("a"))!.was).toBe("absent");
    mem.advanceTo(asSeq(1));
    // What is left starts with the delete of a key the run now holds.
    expect(mem.get(utf("a"))).toMatchObject({ kind: "put", was: "present", seq: 4 });
    mem.advanceTo(asSeq(2));
    expect(mem.get(utf("a"))).toMatchObject({ kind: "put", was: "absent" });
    mem.advanceTo(asSeq(3));
    expect(mem.get(utf("a"))).toMatchObject({ kind: "put", was: "present" });
    expect(mem.get(utf("a"))).not.toHaveProperty("later");
    mem.advanceTo(asSeq(4));
    expect(mem.get(utf("a"))).toBeUndefined();
  });

  it("a range delete that spares a row leaves it unsure of a key it saw present", () => {
    const mem = new Memtable();
    apply(mem, [put("a", "present")], [put("b", "absent")], [put("c", "present")], [put("c", "present")]);
    mem.apply({ seq: asSeq(5), ops: [{ type: "deleteRange", start: checkKey(utf("")), through: asSeq(3) }] });
    // "a" and "b" are covered. "c" keeps its record at seq 4, which saw the record at seq 3: a version the mark covers.
    expect(mem.range().map((r) => [dec.decode(r.key), r.seq, r.was])).toEqual([["c", 4, undefined]]);
  });
});

describe("count", () => {
  let fs: MemoryFs;
  const opened: Db[] = [];

  async function open(options: { cacheBytes?: number } = {}): Promise<Db> {
    const db = await openHarnessDb({ name: NAME, fs, writerId: "w1", maxWalBytes: 1 << 30, ...options });
    opened.push(db);
    return db;
  }

  beforeEach(async () => {
    __resetMemoryFsForTests(NAME);
    await wipe();
    fs = new MemoryFs();
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
    __resetMemoryFsForTests(NAME);
  });

  /** A put or a delete through `update`, which reads the key first, so the write says what the key held. */
  const write = (db: Db, k: Uint8Array, value: Uint8Array | undefined) =>
    db.update([k], (_, tx) => (value ? tx.put(k, value) : tx.delete(k)));

  const scanned = async (db: Db, range?: Range) => (await collect(db.range(range))).length;

  /** Bytes this tab read from run files. */
  async function runBytesRead(db: Db): Promise<number> {
    const read = (await readStats(db)).tab.fs!.read;
    return Object.entries(read).reduce((n, [dir, io]) => (dir.startsWith("l") ? n + io.bytes : n), 0);
  }

  it.each([
    ["informed writes, blind writes, range deletes", 1234, true],
    // With no blind write only a range delete still being compacted away makes a count scan.
    ["informed writes and range deletes", 99, false],
  ])("equals a scan after any mix of %s, flushes and compactions", async (_, seed, blind) => {
    const db = await open();
    const pick = rng(seed);
    const model = new Map<string, string>();
    const check = async (label: string) => {
      const live = [...model.keys()].sort();
      for (let i = 0; i < 12; i++) {
        const [a, b] = [pick(420), pick(420)].sort((x, y) => x - y) as [number, number];
        const range: Range = i === 0 ? {} : { start: key(a), endExclusive: key(b) };
        const want = live.filter((k) => i === 0 || (k >= dec.decode(key(a)) && k < dec.decode(key(b))));
        expect(await db.count(range), `${label}: count ${a}..${b}`).toBe(want.length);
        expect(await scanned(db, range), `${label}: scan ${a}..${b}`).toBe(want.length);
        const offset = pick(want.length + 3);
        const limit = 1 + pick(10);
        const page = (await collect(db.range({ ...range, offset, limit }))).map((e) => dec.decode(e.key));
        expect(page, `${label}: page ${a}..${b} at ${offset}`).toEqual(want.slice(offset, offset + limit));
        const back = (await collect(db.range({ ...range, offset, limit, reverse: true }))).map((e) => dec.decode(e.key));
        expect(back, `${label}: page back ${a}..${b} at ${offset}`).toEqual([...want].reverse().slice(offset, offset + limit));
        expect(await db.count({ ...range, offset }), `${label}: count ${a}..${b} past ${offset}`).toBe(Math.max(0, want.length - offset));
        expect(await db.count({ ...range, offset, limit })).toBe(Math.min(limit, Math.max(0, want.length - offset)));
      }
    };
    for (let round = 0; round < 60; round++) {
      for (let n = 0; n < 40; n++) {
        const k = key(pick(400));
        const id = dec.decode(k);
        // Range deletes come in bursts, so that between a settle and the next burst no mark is left.
        const what = round % 5 === 4 && pick(3) === 0 ? 18 + pick(2) : pick(blind ? 18 : 13);
        if (what < 9) {
          await write(db, k, utf(`r${round}`));
          model.set(id, `r${round}`);
        } else if (what < 13) {
          await write(db, k, undefined);
          model.delete(id);
        } else if (blind && what < 16) {
          await db.put(k, utf(`blind${round}`));
          model.set(id, `blind${round}`);
        } else if (blind && what < 18) {
          await db.delete(k);
          model.delete(id);
        } else if (what % 2 === 0) {
          const a = pick(400);
          const bounds = { start: key(a), endExclusive: key(a + 1 + pick(30)) };
          await db.batch((tx) => tx.deleteRange(bounds));
          for (const live of [...model.keys()]) if (live >= dec.decode(bounds.start) && live < dec.decode(bounds.endExclusive)) model.delete(live);
        } else {
          // Spares what the last flush left unflushed: everything after the seq of a view taken a few writes back.
          const through = Math.max(0, (await db.view((snap) => snap.seq)) - pick(6));
          const a = pick(400);
          const bounds = { start: key(a), endExclusive: key(a + 1 + pick(30)) };
          const before = new Map<string, number>();
          for await (const e of db.range(bounds)) before.set(dec.decode(e.key), 0);
          await db.batch((tx) => tx.deleteRange(bounds, { through }));
          for (const live of before.keys()) if ((await db.get(utf(live))) === undefined) model.delete(live);
        }
      }
      await check(`round ${round}, memtable`);
      if (round % 3 === 0) await ingest(db);
      if (round % 10 === 9) await settle(db);
      await check(`round ${round}`);
    }
  }, 120_000);

  it("of keys written by updates reads two blocks of each level, not the range", async () => {
    const writer = await open();
    const n = 20_000;
    for (let at = 0; at < n; at += 500) {
      const keys = Array.from({ length: 500 }, (_, i) => key(at + i));
      await writer.update(keys, (_, tx) => keys.forEach((k) => tx.put(k, utf("x".repeat(100)))));
      if (at % 5_000 === 4_500) await ingest(writer);
    }
    await settle(writer);
    // Some rows deleted, some rewritten, left in L0 and in the memtable.
    const gone = Array.from({ length: 300 }, (_, i) => key(i * 61));
    await writer.update(gone, (_, tx) => gone.forEach((k) => tx.delete(k)));
    await ingest(writer);
    const more = Array.from({ length: 50 }, (_, i) => key(n + i));
    await writer.update(more, (_, tx) => more.forEach((k) => tx.put(k, utf("y"))));
    const live = n - 300 + 50;
    await writer.close();
    opened.length = 0;

    const cold = await open();
    const before = await runBytesRead(cold);
    expect(await cold.count()).toBe(live);
    expect(await cold.count({ start: key(1_000), endExclusive: key(19_000) })).toBe(18_000 - Array.from({ length: 300 }, (_, i) => i * 61).filter((i) => i >= 1_000 && i < 19_000).length);
    const counted = (await runBytesRead(cold)) - before;
    expect(await scanned(cold)).toBe(live);
    const scannedBytes = (await runBytesRead(cold)) - before - counted;
    // A count reads each run's layout and the blocks the bounds cut. A scan reads every page.
    expect(counted).toBeLessThan(scannedBytes / 4);
  }, 60_000);

  it("a page deep into a range is the page a walk gives, and reads the blocks around it, not the entries it skips", async () => {
    const writer = await open();
    const n = 20_000;
    const live = new Set<number>();
    for (let at = 0; at < n; at += 500) {
      const keys = Array.from({ length: 500 }, (_, i) => key(at + i));
      await writer.update(keys, (_, tx) => keys.forEach((k) => tx.put(k, utf("x".repeat(100)))));
      for (let i = 0; i < 500; i++) live.add(at + i);
      if (at % 4_000 === 3_500) await ingest(writer);
    }
    await settle(writer);
    // Deletes and rewrites in L0, inserts in the memtable: every source has a say in where row n is.
    const gone = Array.from({ length: 900 }, (_, i) => i * 21);
    await writer.update(gone.map(key), (_, tx) => gone.forEach((i) => tx.delete(key(i))));
    for (const i of gone) live.delete(i);
    await ingest(writer);
    const again = Array.from({ length: 300 }, (_, i) => i * 63);
    await writer.update(again.map(key), (_, tx) => again.forEach((i) => tx.put(key(i), utf("back"))));
    for (const i of again) live.add(i);
    const sorted = [...live].sort((a, b) => a - b).map((i) => dec.decode(key(i)));

    const pick = rng(4242);
    const names = async (db: Db, range: Range) => (await collect(db.range(range))).map((e) => dec.decode(e.key));
    for (let i = 0; i < 60; i++) {
      const [a, b] = i % 4 === 0 ? [0, n + 10] : ([pick(n), pick(n)].sort((x, y) => x - y) as [number, number]);
      const range: Range = i % 4 === 0 ? {} : { start: key(a), endExclusive: key(b) };
      const want = sorted.filter((k) => i % 4 === 0 || (k >= dec.decode(key(a)) && k < dec.decode(key(b))));
      const offset = pick(want.length + 50);
      const limit = 1 + pick(7);
      expect(await names(writer, { ...range, offset, limit }), `forward ${a}..${b} at ${offset}`).toEqual(want.slice(offset, offset + limit));
      expect(await names(writer, { ...range, offset, limit, reverse: true }), `back ${a}..${b} at ${offset}`).toEqual(
        [...want].reverse().slice(offset, offset + limit),
      );
    }
    await writer.close();
    opened.length = 0;

    const cold = await open();
    const before = await runBytesRead(cold);
    expect(await names(cold, { offset: 17_000, limit: 3 })).toEqual(sorted.slice(17_000, 17_003));
    expect(await names(cold, { offset: 15_000, limit: 3, reverse: true })).toEqual([...sorted].reverse().slice(15_000, 15_003));
    const deep = (await runBytesRead(cold)) - before;
    expect(await scanned(cold)).toBe(sorted.length);
    const walk = (await runBytesRead(cold)) - before - deep;
    expect(deep).toBeLessThan(walk / 4);
  }, 60_000);

  it("of blind writes scans until they reach the bottom level, and is right both ways", async () => {
    const db = await open();
    await db.batch((tx) => {
      for (let i = 0; i < 2_000; i++) tx.put(key(i), utf("v"));
    });
    expect(await db.count()).toBe(2_000);
    await ingest(db);
    expect(await db.count()).toBe(2_000);
    // Four more flushes merge L0 into the bottom level, where a put is a put over nothing.
    for (let i = 0; i < 4; i++) {
      await db.put(key(3_000 + i), utf("v"));
      await ingest(db);
    }
    await settle(db);
    expect(await db.count()).toBe(2_004);
    expect(await db.count({ start: key(10), endExclusive: key(1_010) })).toBe(1_000);
  });

  it("refuses `was` outside an update, and an offset that is not a whole number", async () => {
    const db = await open();
    await expect(db.batch((tx) => tx.put(key(1), utf("v"), { was: "absent" }))).rejects.toThrow(ConstraintError);
    await expect(db.count({ offset: -1 })).rejects.toThrow(ConstraintError);
    await expect(collect(db.range({ offset: 1.5 }))).rejects.toThrow(ConstraintError);
  });

  it("an update says `was` by itself for a key it read, and takes it for a key it derives", async () => {
    const db = await open();
    const [row, entry] = [utf("row/1"), utf("index/a/1")];
    await db.update([row], ([old], tx) => {
      expect(old).toBeUndefined();
      tx.put(row, utf("doc"));
      tx.put(entry, utf(""), { was: "absent" });
    });
    const seen: unknown[] = [];
    db.changes((e) => seen.push(e));
    await db.update([row], (_, tx) => {
      tx.put(row, utf("doc 2"));
      tx.delete(entry, { was: "present" });
      tx.put(utf("index/b/1"), utf(""), { was: "absent" });
    });
    expect(seen).toMatchObject([{ ops: [{ type: "put", was: "present" }, { type: "del", was: "present" }, { type: "put", was: "absent" }] }]);
    expect(await db.count({ start: utf("index/"), endExclusive: utf("index0") })).toBe(1);
    await ingest(db);
    expect(await db.count({ start: utf("index/"), endExclusive: utf("index0") })).toBe(1);
    expect(await db.count()).toBe(2);
  });
});

describe("liveCount", () => {
  beforeAll(async () => {
    await ensureEngine();
  });

  const reader = async (entries: SstEntry[]) => {
    const run = await encodeRun(entries, "raw");
    return new SstReader(bytesFile(run.body), new PageCache(), run.end.range, undefined, run.end.tally);
  };
  const put = (i: number, seq: number, was?: Was): SstEntry => ({ kind: "put", key: key(i), value: utf("v"), seq: asSeq(seq), was });
  const del = (i: number, seq: number, was?: Was): SstEntry => ({ kind: "del", key: key(i), seq: asSeq(seq), was });

  it("adds the levels up when every record says, and gives up when one does not or a mark meets the bounds", async () => {
    const bottom = await reader(Array.from({ length: 1_000 }, (_, i) => put(i, i + 1, "absent")));
    const newer = await reader([del(10, 2_000, "present"), put(20, 2_001, "present"), put(5_000, 2_002, "absent"), put(6_000, 2_003)]);
    const levels = [new RunLevel([newer]), new RunLevel([bottom])];
    const count = (bounds?: { start?: Uint8Array; endExclusive?: Uint8Array }, marks: Parameters<typeof liveCount>[2] = []) =>
      untilHit(() => liveCount([], levels, marks, bounds));
    expect(await count({ endExclusive: key(5_500) })).toBe(1_000);
    expect(await count({ start: key(10), endExclusive: key(21) })).toBe(10);
    expect(await count({ start: key(11), endExclusive: key(21) })).toBe(10);
    // The blind put at 6000 is in the bounds.
    expect(await count()).toBeUndefined();
    const mark = { start: key(100), endExclusive: key(200), through: asSeq(50), at: asSeq(51) };
    expect(await count({ endExclusive: key(5_500) }, [mark])).toBeUndefined();
    expect(await count({ start: key(200), endExclusive: key(5_500) }, [mark])).toBe(801);
  });
});
