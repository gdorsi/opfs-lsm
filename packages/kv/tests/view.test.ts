import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError } from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
} from "../src/testing.js";

const NAME = "view-test";
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

describe("view snapshot", () => {
  it("pins WAL head so later puts are invisible", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    await db.put(enc.encode("a"), enc.encode("1"));

    const seen = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode("2"));
      await db.put(enc.encode("b"), enc.encode("x"));
      const a = await snap.get(enc.encode("a"));
      const b = await snap.get(enc.encode("b"));
      return {
        a: a ? dec.decode(a) : undefined,
        b: b ? dec.decode(b) : undefined,
        head: snap.seq,
      };
    });

    expect(seen.a).toBe("1");
    expect(seen.b).toBeUndefined();
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
    await db.close();
  });

  it("closes snapshot after callback", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    let leaked: { get(key: Uint8Array): Promise<Uint8Array | undefined> } | undefined;
    await db.view(async (snap) => {
      leaked = snap;
      return null;
    });
    await expect(leaked!.get(enc.encode("a"))).rejects.toThrow(/closed/);
    await db.close();
  });

  it("keeps its rows while later writes split the memtable", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
    await db.batch((tx) => {
      for (let i = 0; i < 3000; i += 2) tx.put(key(i), enc.encode("old"));
    });
    const seen = await db.view(async (snap) => {
      await db.batch((tx) => {
        for (let i = 0; i < 3000; i++) tx.put(key(i), enc.encode("new"));
      });
      const rows: string[] = [];
      for await (const e of snap.range({ start: key(1000), endExclusive: key(1010) })) {
        rows.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
      }
      return { rows, odd: await snap.get(key(1001)), even: await snap.get(key(2998)) };
    });
    expect(seen.rows).toEqual(
      [1000, 1002, 1004, 1006, 1008].map((i) => `k${String(i).padStart(5, "0")}=old`),
    );
    expect(seen.odd).toBeUndefined();
    expect(dec.decode(seen.even!)).toBe("old");
    expect(dec.decode((await db.get(key(1001)))!)).toBe("new");
    await db.close();
  });
});

describe("the bytes a get hands out", () => {
  it("own their buffer, and changing them changes no later read", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    await db.put(enc.encode("run"), enc.encode("in a run"));
    await ingest(db);
    await db.put(enc.encode("mem"), enc.encode("in the memtable"));
    const reads: [string, (key: Uint8Array) => Promise<Uint8Array | undefined>][] = [
      ["get", (key) => db.get(key)],
      ["view get", (key) => db.view((snap) => snap.get(key))],
      ["getMany", async (key) => (await db.getMany([key]))[0]],
      ["view getMany", (key) => db.view(async (snap) => (await snap.getMany([key]))[0])],
      ["update", (key) => db.update([key], ([value]) => value)],
      ["rangeJoin", (key) => db.view(async (snap) => (await snap.rangeJoin({ start: key, limit: 1 }, () => key))[0]!.joined)],
    ];
    for (const [what, read] of reads) {
      for (const [key, want] of [["run", "in a run"], ["mem", "in the memtable"]] as const) {
        const got = (await read(enc.encode(key)))!;
        expect(`${what} ${key}: ${dec.decode(got)}, offset ${got.byteOffset}, buffer ${got.buffer.byteLength}`).toBe(
          `${what} ${key}: ${want}, offset 0, buffer ${want.length}`,
        );
        got.fill(0);
        expect(`${what} ${key}: ${dec.decode((await read(enc.encode(key)))!)}`).toBe(`${what} ${key}: ${want}`);
      }
    }
    await db.close();
  });
});

describe("getMany", () => {
  it("reads every key in the order asked, from runs and the memtable, and decodes in place", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    await db.batch((tx) => {
      tx.put(enc.encode("run"), enc.encode("in a run"));
      tx.put(enc.encode("gone"), enc.encode("deleted later"));
    });
    await ingest(db);
    await db.put(enc.encode("mem"), enc.encode("in the memtable"));
    await db.delete(enc.encode("gone"));
    const keys = ["mem", "missing", "run", "gone", "run"].map((k) => enc.encode(k));
    const want = ["in the memtable", undefined, "in a run", undefined, "in a run"];
    const text = (bytes: Uint8Array) => dec.decode(bytes);
    const reads = [
      async () => (await db.getMany(keys)).map((v) => v && text(v)),
      () => db.getMany(keys, text),
      () => db.view(async (snap) => (await snap.getMany(keys)).map((v) => v && text(v))),
      () => db.view((snap) => snap.getMany(keys, text)),
      () => db.view(async (snap) => (await snap.rangeJoin({}, (e) => e.key, text)).map((hit) => hit.joined)),
    ];
    for (const read of reads.slice(0, 4)) {
      const got = await read();
      expect(got).toEqual(want);
      // A key with no value is an element, not a hole.
      expect(Object.keys(got)).toHaveLength(keys.length);
    }
    expect(await reads[4]!()).toEqual(["in the memtable", "in a run"]);
    expect(await db.getMany([])).toEqual([]);
    await db.close();
  });

  it("reads a view's snapshot, not later writes", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    await db.put(enc.encode("a"), enc.encode("1"));
    const got = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode("2"));
      await db.put(enc.encode("b"), enc.encode("x"));
      return snap.getMany([enc.encode("a"), enc.encode("b")], (bytes) => dec.decode(bytes));
    });
    expect(got).toEqual(["1", undefined]);
    expect(await db.getMany([enc.encode("a"), enc.encode("b")], (bytes) => dec.decode(bytes))).toEqual(["2", "x"]);
    await db.close();
  });
});

describe("reverse range", () => {
  const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
  const keysOf = async (rows: AsyncIterable<{ key: Uint8Array; value: Uint8Array }>) => {
    const out: string[] = [];
    for await (const r of rows) out.push(`${dec.decode(r.key)}=${dec.decode(r.value)}`);
    return out;
  };

  async function seeded() {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    await db.batch((tx) => {
      for (let i = 0; i < 3000; i += 2) tx.put(key(i), enc.encode(`sst${i}`));
    });
    await ingest(db);
    await db.batch((tx) => {
      for (let i = 0; i < 3000; i += 3) tx.put(key(i), enc.encode(`l0-${i}`));
      for (let i = 2; i < 3000; i += 10) tx.delete(key(i));
    });
    await ingest(db);
    await db.batch((tx) => {
      for (let i = 0; i < 3000; i += 5) tx.put(key(i), enc.encode(`mem${i}`));
      for (let i = 1; i < 3000; i += 14) tx.delete(key(i));
      for (let i = 3; i < 3000; i += 6) tx.delete(key(i));
    });
    return db;
  }

  const bounds = [
    {},
    { start: key(100) },
    { endExclusive: key(2900) },
    { start: key(500), endExclusive: key(510) },
    { start: key(1000), endExclusive: key(1000) },
    { start: key(2990) },
    { endExclusive: key(2) },
    { start: key(1), endExclusive: key(2) },
  ];
  const limits = [undefined, 0, 1, 5];

  it("yields the forward rows in descending order, and limit takes the last rows", async () => {
    const db = await seeded();
    let rows = 0;
    for (const b of bounds) {
      const forward = await keysOf(db.range(b));
      rows += forward.length;
      for (const limit of limits) {
        const range = { ...b, reverse: true, ...(limit !== undefined ? { limit } : {}) };
        const want = [...forward].reverse().slice(0, limit);
        expect(await keysOf(db.range(range))).toEqual(want);
        expect(await db.view((snap) => keysOf(snap.range(range)))).toEqual(want);
      }
    }
    expect(rows).toBeGreaterThan(2_000);
    await db.close();
  });

  it("passes over offset entries before the first, in both directions, in range and count", async () => {
    const db = await seeded();
    for (const b of bounds) {
      const forward = await keysOf(db.range(b));
      for (const reverse of [false, true]) {
        const all = reverse ? [...forward].reverse() : forward;
        for (const offset of [0, 1, 7, 400, 5_000]) {
          for (const limit of limits) {
            const range = { ...b, reverse, offset, ...(limit !== undefined ? { limit } : {}) };
            const want = all.slice(offset, limit === undefined ? undefined : offset + limit);
            expect(await keysOf(db.range(range))).toEqual(want);
            expect(await db.count(range)).toBe(want.length);
            expect(await db.view((snap) => snap.count(range))).toBe(want.length);
          }
        }
      }
    }
    await db.close();
  });

  it("rejects a limit or an offset that is not an integer >= 0", async () => {
    const db = await seeded();
    for (const bad of [-1, 1.5, Number.NaN]) {
      for (const range of [{ limit: bad }, { offset: bad }]) {
        await expect(keysOf(db.range(range))).rejects.toBeInstanceOf(ConstraintError);
        await expect(db.count(range)).rejects.toBeInstanceOf(ConstraintError);
        await expect(db.view((snap) => snap.count(range))).rejects.toBeInstanceOf(ConstraintError);
        await expect(db.view((snap) => snap.rangeValues(range, () => 0))).rejects.toBeInstanceOf(ConstraintError);
      }
    }
    await db.close();
  });

  it("rangeValues hands each value of the range to decode, where range yields a copy", async () => {
    const db = await seeded();
    for (const b of bounds) {
      for (const reverse of [false, true]) {
        const range = { ...b, reverse, offset: 2, limit: 40 };
        const got = await db.view((snap) => snap.rangeValues(range, (bytes) => dec.decode(bytes)));
        expect(got.map((e) => `${dec.decode(e.key)}=${e.value}`)).toEqual(await keysOf(db.range(range)));
        for (const e of got) expect(e.key.byteLength).toBe(e.key.buffer.byteLength);
      }
    }
    await db.close();
  });

  it("scans under range deletes yield what point gets find, whichever bounds cut the deleted ranges", async () => {
    const db = await seeded();
    await db.batch((tx) => {
      tx.deleteRange({ start: key(600), endExclusive: key(900) });
      tx.deleteRange({ start: key(2950) });
      tx.deleteRange({ start: key(0), endExclusive: key(3) });
    });
    // Unflushed, so the marks stay over the runs' versions.
    await db.batch((tx) => {
      for (let i = 700; i < 720; i++) tx.put(key(i), enc.encode(`back${i}`));
      tx.put(key(1), enc.encode("again"));
    });
    const live: string[] = [];
    const values = await db.getMany(Array.from({ length: 3000 }, (_, i) => key(i)));
    values.forEach((v, i) => v && live.push(`${dec.decode(key(i))}=${dec.decode(v)}`));
    expect(live.length).toBeGreaterThan(1_000);
    const cuts = [...bounds, { start: key(650), endExclusive: key(710) }, { start: key(890), endExclusive: key(2960) }, { endExclusive: key(601) }];
    for (const b of cuts) {
      const lo = b.start ? dec.decode(b.start) : "";
      const hi = b.endExclusive ? dec.decode(b.endExclusive) : "~";
      const want = live.filter((row) => row.slice(0, 6) >= lo && row.slice(0, 6) < hi);
      for (const reverse of [false, true]) {
        const range = { ...b, reverse };
        const ordered = reverse ? [...want].reverse() : want;
        expect(await keysOf(db.range(range))).toEqual(ordered);
        expect(await db.count(range)).toBe(want.length);
        expect(await db.view((snap) => keysOf(snap.range(range)))).toEqual(ordered);
      }
    }
    await db.close();
  });

  it("reads the snapshot backward, not later writes", async () => {
    const db = await seeded();
    const range = { start: key(1000), endExclusive: key(1040) };
    const forward = await keysOf(db.range(range));
    const got = await db.view(async (snap) => {
      await db.batch((tx) => {
        for (let i = 1000; i < 1040; i++) tx.put(key(i), enc.encode("later"));
      });
      return keysOf(snap.range({ ...range, reverse: true }));
    });
    expect(got).toEqual([...forward].reverse());
    await db.close();
  });
});

describe("range with valueContains", () => {
  async function seeded() {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    await db.put(enc.encode("a"), enc.encode(" red apple"));
    await db.put(enc.encode("b"), enc.encode(" red pear"));
    await db.put(enc.encode("c"), enc.encode(" red plum"));
    await db.put(enc.encode("e"), enc.encode(" red fig"));
    await db.put(enc.encode("f"), enc.encode(" blue"));
    await ingest(db);
    await db.put(enc.encode("b"), enc.encode(" green pear"));
    await db.delete(enc.encode("c"));
    await db.put(enc.encode("d"), enc.encode(" red kiwi"));
    await db.put(enc.encode("e"), enc.encode(" red fig ripe"));
    return db;
  }
  const red = [enc.encode(" red")];
  const pairs = async (rows: AsyncIterable<{ key: Uint8Array; value: Uint8Array }>) => {
    const out: string[] = [];
    for await (const r of rows) out.push(`${dec.decode(r.key)}=${dec.decode(r.value)}`);
    return out;
  };

  it("yields each matching key once with its current value, in key order", async () => {
    const db = await seeded();
    const want = ["a= red apple", "d= red kiwi", "e= red fig ripe"];
    expect(await pairs(db.range({ valueContains: red }))).toEqual(want);
    expect(await db.view((snap) => pairs(snap.range({ valueContains: red })))).toEqual(want);
    await db.close();
  });

  it("honours bounds, and limit counts matches", async () => {
    const db = await seeded();
    expect(await pairs(db.range({ start: enc.encode("b"), endExclusive: enc.encode("e"), valueContains: red }))).toEqual([
      "d= red kiwi",
    ]);
    expect(await pairs(db.range({ limit: 2, valueContains: red }))).toEqual(["a= red apple", "d= red kiwi"]);
    await db.close();
  });

  it("yields the forward matches in descending order, and limit counts matches", async () => {
    const db = await seeded();
    const e = (s: string) => enc.encode(s);
    for (const b of [{}, { start: e("b"), endExclusive: e("e") }, { start: e("d") }, { endExclusive: e("d") }]) {
      const forward = await pairs(db.range({ ...b, valueContains: red }));
      for (const limit of [undefined, 1, 2]) {
        const range = { ...b, valueContains: red, reverse: true, ...(limit !== undefined ? { limit } : {}) };
        const want = [...forward].reverse().slice(0, limit);
        expect(await pairs(db.range(range))).toEqual(want);
        expect(await db.view((snap) => pairs(snap.range(range)))).toEqual(want);
      }
    }
    await db.close();
  });

  it("keeps only values that hold every pattern", async () => {
    const db = await seeded();
    expect(await pairs(db.range({ valueContains: [enc.encode(" red"), enc.encode(" fig")] }))).toEqual(["e= red fig ripe"]);
    await db.close();
  });

  it("sees the view's snapshot, not later writes", async () => {
    const db = await seeded();
    const got = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode(" blue apple"));
      await db.put(enc.encode("g"), enc.encode(" red grape"));
      return pairs(snap.range({ valueContains: red }));
    });
    expect(got).toEqual(["a= red apple", "d= red kiwi", "e= red fig ripe"]);
    expect(await pairs(db.range({ valueContains: red }))).toEqual(["d= red kiwi", "e= red fig ripe", "g= red grape"]);
    await db.close();
  });

  it("closes with the snapshot", async () => {
    const db = await seeded();
    const snap = await db.view((s) => s);
    await expect(pairs(snap.range({ valueContains: red }))).rejects.toThrow(/closed/);
    await db.close();
  });

  it("hands out bytes that own their buffer", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    await db.put(enc.encode("a"), enc.encode(" red apple"));
    await db.put(enc.encode("b"), enc.encode(" red pear"));
    await ingest(db);
    await db.put(enc.encode("c"), enc.encode(" red plum"));
    const owned = await db.view(async (snap) => {
      const flags: boolean[] = [];
      for (const range of [{}, { valueContains: [enc.encode(" red")] }]) {
        for await (const e of snap.range(range)) {
          for (const b of [e.key, e.value]) {
            flags.push(b.byteOffset === 0 && b.buffer.byteLength === b.byteLength);
          }
        }
      }
      return flags;
    });
    expect(owned).toEqual(Array(12).fill(true));
    await db.close();
  });
});
