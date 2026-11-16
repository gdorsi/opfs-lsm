import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { prefixBound } from "../src/db.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { __resetMemoryFsForTests, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import {
  decodeTuple,
  encodeTuple,
  skipTuple,
  stringPrefixBounds,
  tupleBounds,
  type TupleBounds,
  type TupleValue,
} from "../src/tuple.js";

const RUNS = Number(process.env.KV_TUPLE_RUNS ?? 500);
const utf8 = new TextEncoder();
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const hex = (key: Uint8Array) => Array.from(key, (b) => b.toString(16).padStart(2, "0")).join(" ");

const within = (key: Uint8Array, b: TupleBounds) => compareBytes(key, b.start) >= 0 && compareBytes(key, b.endExclusive) < 0;

function rank(v: TupleValue): number {
  if (v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  return typeof v === "number" ? 3 : 4;
}

function codePoints(s: string): number[] {
  return Array.from(s, (c) => c.codePointAt(0)!);
}

/** The order the layout promises, written from the definition rather than from the encoding. */
function compareValue(a: TupleValue, b: TupleValue): number {
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    const x = codePoints(a);
    const y = codePoints(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  }
  return 0;
}

function compareTuple(a: readonly TupleValue[], b: readonly TupleValue[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareValue(a[i]!, b[i]!);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const extendsTuple = (q: readonly TupleValue[], p: readonly TupleValue[]) =>
  q.length >= p.length && p.every((v, i) => compareValue(v, q[i]!) === 0);

const unitArb = fc.constantFrom("\0", "a", "b", "\u0001", "\u0005", "ÿ", "\u{ffff}", "😀");
/** Few distinct characters, so equal strings, prefixes, U+0000 and tag bytes collide often. */
const denseStringArb = fc.string({ unit: unitArb, maxLength: 3 });

const numberArb = fc.oneof(
  fc.constantFrom(-0, 0, 1, -1, 0.5, -0.5, 2 ** 53, -(2 ** 53), Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

const valueArb: fc.Arbitrary<TupleValue> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<TupleValue>(null, false, true, -0, 0, 1, -1, 0.5) },
  { weight: 6, arbitrary: denseStringArb },
  { weight: 1, arbitrary: numberArb },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 6 }) },
);

const tupleArb = fc.array(valueArb, { maxLength: 3 });
const prefixArb = fc.uint8Array({ maxLength: 4 });
/** An id: raw UTF-8, which never holds an FF byte. */
const tailArb = fc.string({ unit: unitArb, maxLength: 3 }).map((s) => utf8.encode(s));

describe("encodeTuple", () => {
  it("orders keys the way the tuples order", () => {
    fc.assert(
      fc.property(tupleArb, tupleArb, (a, b) => {
        expect(sign(compareBytes(encodeTuple(a), encodeTuple(b)))).toBe(sign(compareTuple(a, b)));
      }),
      { numRuns: RUNS * 10 },
    );
  });

  it("orders null, false, true, numbers ascending with -0 equal to 0, then strings", () => {
    const values: TupleValue[] = [null, false, true, -Number.MAX_VALUE, -1, -0.5, 0, 0.5, 1, Number.MAX_VALUE, "", "a"];
    const keys = values.map((v) => encodeTuple([v]));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    expect(encodeTuple([-0])).toEqual(encodeTuple([0]));
  });

  it("orders strings by code point, U+0000 inside a string after the string that stops there", () => {
    const sorted = ["b", "aa", "a\u0000b", "a", "", "￿", "😀"]
      .map((s) => ({ s, key: encodeTuple([s]) }))
      .sort((x, y) => compareBytes(x.key, y.key))
      .map((x) => x.s);
    expect(sorted).toEqual(["", "a", "a\u0000b", "aa", "b", "￿", "😀"]);
  });

  it("writes the documented bytes", () => {
    expect(hex(encodeTuple([null, false, true]))).toBe("01 02 03");
    expect(hex(encodeTuple([0, -0, 1, -1]))).toBe("04 80 00 00 00 00 00 00 00 04 80 00 00 00 00 00 00 00 04 bf f0 00 00 00 00 00 00 04 40 0f ff ff ff ff ff ff");
    expect(hex(encodeTuple(["", "a\u0000b", "é"]))).toBe("05 00 05 61 00 ff 62 00 05 c3 a9 00");
  });

  it("puts the prefix before the fields and the tail after them", () => {
    expect(hex(encodeTuple([true, "a"], Uint8Array.of(0x64, 0x00), Uint8Array.of(0x78)))).toBe("64 00 03 05 61 00 78");
    expect(encodeTuple([])).toEqual(new Uint8Array(0));
  });

  it("rejects a tail that starts with FF and keeps encoding afterwards", () => {
    fc.assert(
      fc.property(tupleArb, fc.uint8Array({ maxLength: 3 }), (values, rest) => {
        expect(() => encodeTuple(values, undefined, Uint8Array.of(0xff, ...rest))).toThrow(RangeError);
      }),
      { numRuns: RUNS },
    );
    expect(hex(encodeTuple(["a"]))).toBe("05 61 00");
  });

  it.each<[string, unknown, ErrorConstructor]>([
    ["a lone high surrogate", "a\ud800", RangeError],
    ["a lone low surrogate", "\udfffa", RangeError],
    ["NaN", Number.NaN, RangeError],
    ["Infinity", Number.POSITIVE_INFINITY, RangeError],
    ["-Infinity", Number.NEGATIVE_INFINITY, RangeError],
    ["undefined", undefined, TypeError],
    ["a bigint", 1n, TypeError],
    ["an object", {}, TypeError],
    ["an array", [], TypeError],
  ])("rejects %s and keeps encoding afterwards", (_, v, error) => {
    expect(() => encodeTuple(["ok", v as TupleValue])).toThrow(error);
    expect(hex(encodeTuple(["a", 1]))).toBe("05 61 00 04 bf f0 00 00 00 00 00 00");
  });
});

describe("decodeTuple", () => {
  it("returns what encodeTuple was given, with -0 as 0", () => {
    fc.assert(
      fc.property(tupleArb, (values) => {
        const key = encodeTuple(values);
        const out = decodeTuple(key);
        expect(out.values.map((v) => (v === 0 ? 0 : v))).toEqual(values.map((v) => (v === 0 ? 0 : v)));
        expect(out.end).toBe(key.length);
      }),
      { numRuns: RUNS * 4 },
    );
  });

  it("reads `count` fields at `from` and leaves the tail, whatever its first byte", () => {
    fc.assert(
      fc.property(tupleArb, prefixArb, tailArb, (values, prefix, tail) => {
        const key = encodeTuple(values, prefix, tail);
        const out = decodeTuple(key, values.length, prefix.length);
        expect(out.values.map((v) => (v === 0 ? 0 : v))).toEqual(values.map((v) => (v === 0 ? 0 : v)));
        expect(key.subarray(out.end)).toEqual(tail);
        expect(skipTuple(key, values.length, prefix.length)).toBe(out.end);
      }),
      { numRuns: RUNS * 4 },
    );
  });

  it("reads a tail that looks like a field only because `count` says where the tuple ends", () => {
    const key = encodeTuple([1], undefined, utf8.encode("\u0001"));
    expect(decodeTuple(key, 1).values).toEqual([1]);
    expect(decodeTuple(key).values).toEqual([1, null]);
  });

  it.each<[string, number[], number | undefined]>([
    ["an unknown tag", [0x06], undefined],
    ["a 00 where a tag belongs", [0x00], undefined],
    ["a number cut short", [0x04, 0x80, 0x00], undefined],
    ["a string with no terminator", [0x05, 0x61], undefined],
    ["a string that ends on an escape", [0x05, 0x61, 0x00, 0xff], undefined],
    ["fewer fields than count", [0x01], 2],
  ])("rejects %s with CorruptDatabaseError", (_, bytes, count) => {
    expect(() => decodeTuple(Uint8Array.from(bytes), count)).toThrow(CorruptDatabaseError);
    expect(() => skipTuple(Uint8Array.from(bytes), count ?? 1)).toThrow(CorruptDatabaseError);
  });
});

describe("tupleBounds", () => {
  it("holds exactly the tuples that continue the prefix, and keys that continue it with a tail", () => {
    fc.assert(
      fc.property(tupleArb, tupleArb, prefixArb, tailArb, (p, q, raw, tail) => {
        const bounds = tupleBounds(encodeTuple(p, raw));
        expect(within(encodeTuple(q, raw), bounds)).toBe(extendsTuple(q, p));
        expect(within(encodeTuple(p, raw, tail), bounds)).toBe(true);
        expect(within(encodeTuple([...p, ...q], raw, tail), bounds)).toBe(true);
      }),
      { numRuns: RUNS * 10 },
    );
  });

  it("holds ['a'] and everything after it, and not 'a\\u0000', 'a\\u0000b' or 'ab'", () => {
    const bounds = tupleBounds(encodeTuple(["a"]));
    const holds = (values: TupleValue[], tail?: Uint8Array) => within(encodeTuple(values, undefined, tail), bounds);
    expect(holds(["a"])).toBe(true);
    expect(holds(["a", null])).toBe(true);
    expect(holds(["a", "\u0000"])).toBe(true);
    expect(holds(["a", Number.MAX_VALUE, "z"])).toBe(true);
    expect(holds(["a"], utf8.encode("id"))).toBe(true);
    expect(holds(["a"], utf8.encode("\u0000id"))).toBe(true);
    expect(holds(["a"], utf8.encode("\u{10ffff}"))).toBe(true);
    expect(holds(["a\u0000"])).toBe(false);
    expect(holds(["a\u0000b"])).toBe(false);
    expect(holds(["ab"])).toBe(false);
    expect(holds([])).toBe(false);
  });

  it("is what prefixBound is not: prefixBound of ['a'] holds 'a\\u0000'", () => {
    const raw = prefixBound(encodeTuple(["a"]));
    expect(within(encodeTuple(["a\u0000"]), { start: raw.start, endExclusive: raw.endExclusive! })).toBe(true);
    expect(within(encodeTuple(["a\u0000"]), tupleBounds(encodeTuple(["a"])))).toBe(false);
  });

  it("returns the prefix itself as the lower bound and a longer key as the upper", () => {
    const prefix = encodeTuple(["a", 1]);
    const bounds = tupleBounds(prefix);
    expect(bounds.start).toBe(prefix);
    expect(hex(bounds.endExclusive)).toBe(`${hex(prefix)} ff`);
  });
});

describe("stringPrefixBounds", () => {
  it("holds exactly the strings that start with `s`, with any fields after them", () => {
    fc.assert(
      fc.property(denseStringArb, denseStringArb, tupleArb, prefixArb, (s, t, rest, raw) => {
        const bounds = stringPrefixBounds(raw, s);
        expect(within(encodeTuple([t], raw), bounds)).toBe(t.startsWith(s));
        expect(within(encodeTuple([t, ...rest], raw), bounds)).toBe(t.startsWith(s));
      }),
      { numRuns: RUNS * 10 },
    );
  });

  it("holds no other kind of value", () => {
    const bounds = stringPrefixBounds(new Uint8Array(0), "");
    for (const v of [null, false, true, -Number.MAX_VALUE, 0, Number.MAX_VALUE]) {
      expect(within(encodeTuple([v]), bounds)).toBe(false);
    }
    expect(within(encodeTuple([""]), bounds)).toBe(true);
  });

  it("rejects a lone surrogate", () => {
    expect(() => stringPrefixBounds(new Uint8Array(0), "\ud800")).toThrow(RangeError);
  });
});

describe("a range scan over the bounds", () => {
  const NAME = "tuple-bounds";
  const pool: TupleValue[] = [null, true, 1, "a", "a\u0000", "a\u0000b", "ab"];
  const tuples: TupleValue[][] = [...pool.map((v) => [v]), ...pool.flatMap((v) => pool.map((w) => [v, w]))];
  const tails = [undefined, utf8.encode("id"), utf8.encode("\u0000id")];
  const stored = tuples.flatMap((values) => tails.map((tail) => ({ values, tail, key: encodeTuple(values, undefined, tail) })));
  let closeDb: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeDb?.();
    closeDb = undefined;
    __resetMemoryFsForTests(NAME);
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it("yields every stored key that continues the prefix, in key order, from the log and from an SST", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs(), forceMemory: true, writerId: "w1", maxWalBytes: 1 << 30 });
    closeDb = () => db.close();
    await db.batch((tx) => {
      for (const { key } of stored) tx.put(key, utf8.encode("v"));
    });

    const scan = async (bounds: TupleBounds) => {
      const out: string[] = [];
      for await (const e of db.range(bounds)) out.push(hex(e.key));
      return out;
    };
    const check = async () => {
      for (const p of tuples) {
        const expected = stored
          .filter((e) => extendsTuple(e.values, p))
          .map((e) => e.key)
          .sort(compareBytes)
          .map(hex);
        expect(await scan(tupleBounds(encodeTuple(p)))).toEqual(expected);
      }
      for (const s of ["", "a", "a\u0000", "ab", "b"]) {
        const expected = stored
          .filter((e) => typeof e.values[0] === "string" && e.values[0].startsWith(s))
          .map((e) => e.key)
          .sort(compareBytes)
          .map(hex);
        expect(await scan(stringPrefixBounds(new Uint8Array(0), s))).toEqual(expected);
      }
    };

    await check();
    await ingest(db);
    await check();
  });
});
