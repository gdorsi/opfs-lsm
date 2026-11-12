import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import {
  covered,
  decodeMarks,
  encodeMarks,
  joinMarks,
  markCursor,
  markTable,
  NO_MARKS,
  retireMarks,
  throughAt,
  type Mark,
  type Marks,
  type RunMarkInfo,
} from "../src/store/marks.js";

const keyArb = fc.uint8Array({ minLength: 0, maxLength: 3, max: 3 });
const markArb: fc.Arbitrary<Mark> = fc
  .record({
    a: keyArb,
    b: fc.option(keyArb, { nil: undefined }),
    through: fc.integer({ min: 0, max: 20 }),
    gap: fc.integer({ min: 1, max: 20 }),
  })
  .map(({ a, b, through, gap }) => {
    const [start, end] = b && compareBytes(b, a) < 0 ? [b, a] : [a, b];
    return { start, ...(end ? { endExclusive: end } : {}), through, at: through + gap };
  });
const marksArb = fc.array(markArb, { maxLength: 8 });

function fold(list: readonly Mark[]): Marks {
  return list.reduce((acc, m) => joinMarks(acc, markTable(m)), NO_MARKS);
}

function inRange(m: Mark, key: Uint8Array): boolean {
  return compareBytes(key, m.start) >= 0 && (!m.endExclusive || compareBytes(key, m.endExclusive) < 0);
}

/** The naive verdict: some mark of the list covers the version. */
function naive(list: readonly Mark[], key: Uint8Array, seq: number): boolean {
  return list.some((m) => inRange(m, key) && seq <= m.through);
}

/** Two tables are the same when they encode the same. */
const bytesOf = (m: Marks) => [...encodeMarks(m)];

describe("marks", () => {
  it("answers as the naive list of marks does", () => {
    fc.assert(
      fc.property(marksArb, keyArb, fc.integer({ min: 1, max: 25 }), (list, key, seq) => {
        expect(covered(fold(list), key, seq)).toBe(naive(list, key, seq));
      }),
    );
  });

  it("join is commutative, associative and idempotent", () => {
    fc.assert(
      fc.property(marksArb, marksArb, marksArb, (x, y, z) => {
        const [a, b, c] = [fold(x), fold(y), fold(z)];
        expect(bytesOf(joinMarks(a, b))).toEqual(bytesOf(joinMarks(b, a)));
        expect(bytesOf(joinMarks(joinMarks(a, b), c))).toEqual(bytesOf(joinMarks(a, joinMarks(b, c))));
        expect(bytesOf(joinMarks(a, a))).toEqual(bytesOf(a));
      }),
    );
  });

  it("a cursor answers as the lookup does, both ways", () => {
    fc.assert(
      fc.property(marksArb, fc.array(keyArb, { maxLength: 12 }), (list, keys) => {
        const marks = fold(list);
        const sorted = [...keys].sort(compareBytes);
        const forward = markCursor(marks);
        for (const k of sorted) expect(forward.at(k)).toBe(throughAt(marks, k));
        const backward = markCursor(marks, true);
        for (const k of sorted.reverse()) expect(backward.at(k)).toBe(throughAt(marks, k));
      }),
    );
  });

  const runArb: fc.Arbitrary<RunMarkInfo> = fc
    .record({ a: keyArb, b: keyArb, marksThrough: fc.integer({ min: 0, max: 45 }), empty: fc.boolean() })
    .map(({ a, b, marksThrough, empty }) => {
      const [smallest, largest] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
      return empty ? { marksThrough } : { range: { smallest, largest }, marksThrough };
    });

  /** A run holds no version a mark it applied covers. */
  function holdable(list: readonly Mark[], run: RunMarkInfo, key: Uint8Array, seq: number): boolean {
    if (!run.range) return false;
    if (compareBytes(key, run.range.smallest) < 0 || compareBytes(key, run.range.largest) > 0) return false;
    return !list.some((m) => m.at <= run.marksThrough && inRange(m, key) && seq <= m.through);
  }

  it("retirement never changes the verdict for a version a listed run can hold", () => {
    fc.assert(
      fc.property(
        marksArb,
        fc.array(runArb, { maxLength: 5 }),
        fc.array(fc.tuple(keyArb, fc.integer({ min: 1, max: 45 })), { maxLength: 30 }),
        (list, runs, versions) => {
          const marks = fold(list);
          const retired = retireMarks(marks, runs);
          for (const [key, seq] of versions) {
            if (!runs.some((run) => holdable(list, run, key, seq))) continue;
            expect(covered(retired, key, seq)).toBe(covered(marks, key, seq));
          }
        },
      ),
    );
  });

  it("retires a piece once no run that can hold it is listed", () => {
    const k = (s: string) => new TextEncoder().encode(s);
    const marks = markTable({ start: k("b"), endExclusive: k("d"), through: 5, at: 6 });
    const before = { range: { smallest: k("a"), largest: k("c") }, marksThrough: 3 };
    const after = { range: { smallest: k("a"), largest: k("c") }, marksThrough: 9 };
    const elsewhere = { range: { smallest: k("x"), largest: k("y") }, marksThrough: 0 };
    expect(retireMarks(marks, [before, elsewhere]).empty).toBe(false);
    expect(retireMarks(marks, [after, elsewhere]).empty).toBe(true);
  });

  it("round-trips through its encoding and rejects a broken block", () => {
    fc.assert(
      fc.property(marksArb, (list) => {
        const marks = fold(list);
        const bytes = encodeMarks(marks);
        const { marks: back, end } = decodeMarks(bytes, 0, bytes.byteLength, 1000);
        expect(end).toBe(bytes.byteLength);
        expect(bytesOf(back)).toEqual(bytesOf(marks));
        expect(() => decodeMarks(bytes, 0, bytes.byteLength - 1, 1000)).toThrow(CorruptDatabaseError);
        if (!marks.empty) expect(() => decodeMarks(bytes, 0, bytes.byteLength, 0)).toThrow(CorruptDatabaseError);
      }),
    );
  });
});
