import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { decodeMarks, encodeMarks, retireMarks, throughAt, type Mark } from "../src/store/marks.js";

type RunMarkInfo = Parameters<typeof retireMarks>[1][number];

const keyArb = fc.uint8Array({ minLength: 0, maxLength: 3, max: 3 });
const markArb: fc.Arbitrary<Mark> = fc
  .record({
    a: keyArb,
    b: fc.option(keyArb, { nil: undefined }),
    through: fc.integer({ min: 1, max: 20 }),
    gap: fc.integer({ min: 1, max: 20 }),
  })
  .map(({ a, b, through, gap }) => {
    const [start, end] = b && compareBytes(b, a) < 0 ? [b, a] : [a, b];
    return { start, ...(end ? { endExclusive: end } : {}), through, at: through + gap };
  })
  .filter((m) => !m.endExclusive || compareBytes(m.start, m.endExclusive) < 0);
const marksArb = fc.array(markArb, { maxLength: 8 });

function inRange(m: Mark, key: Uint8Array): boolean {
  return compareBytes(key, m.start) >= 0 && (!m.endExclusive || compareBytes(key, m.endExclusive) < 0);
}

const k = (s: string) => new TextEncoder().encode(s);
const bytesOf = (list: readonly Mark[]) => [...encodeMarks(list)];

describe("marks", () => {
  it("looks up the max through of the marks that hold the key", () => {
    fc.assert(
      fc.property(marksArb, keyArb, (list, key) => {
        const covering = list.filter((m) => inRange(m, key)).map((m) => m.through);
        expect(throughAt(list, key)).toBe(Math.max(0, ...covering));
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
          const retired = retireMarks(list, runs);
          for (const [key, seq] of versions) {
            if (!runs.some((run) => holdable(list, run, key, seq))) continue;
            expect(seq <= throughAt(retired, key)).toBe(seq <= throughAt(list, key));
          }
        },
      ),
    );
  });

  it("retires a mark once no run that can hold it is listed", () => {
    const marks = [{ start: k("b"), endExclusive: k("d"), through: 5, at: 6 }];
    const before = { range: { smallest: k("a"), largest: k("c") }, marksThrough: 3 };
    const after = { range: { smallest: k("a"), largest: k("c") }, marksThrough: 9 };
    const elsewhere = { range: { smallest: k("x"), largest: k("y") }, marksThrough: 0 };
    expect(retireMarks(marks, [before, elsewhere])).toBe(marks);
    expect(retireMarks(marks, [after, elsewhere])).toEqual([]);
  });

  it("round-trips through its encoding and rejects truncation", () => {
    fc.assert(
      fc.property(marksArb, (list) => {
        const bytes = encodeMarks(list);
        const { marks, end } = decodeMarks(bytes, 0, bytes.byteLength, 1000);
        expect(end).toBe(bytes.byteLength);
        expect(bytesOf(marks)).toEqual(bytesOf(list));
        expect(() => decodeMarks(bytes, 0, bytes.byteLength - 1, 1000)).toThrow(CorruptDatabaseError);
      }),
    );
  });

  it("rejects a mark that breaks a rule", () => {
    const ok: Mark = { start: k("a"), endExclusive: k("b"), through: 2, at: 3 };
    const decode = (m: Mark, maxAt = 9) => {
      const bytes = encodeMarks([m]);
      return decodeMarks(bytes, 0, bytes.byteLength, maxAt);
    };
    expect(decode(ok).marks).toHaveLength(1);
    expect(() => decode({ ...ok, endExclusive: k("a") })).toThrow(CorruptDatabaseError);
    expect(() => decode({ ...ok, endExclusive: k("") })).toThrow(CorruptDatabaseError);
    expect(() => decode({ ...ok, through: 0 })).toThrow(CorruptDatabaseError);
    expect(() => decode({ ...ok, at: 2 })).toThrow(CorruptDatabaseError);
    expect(() => decode(ok, 2)).toThrow(CorruptDatabaseError);
    expect(() => decode({ ...ok, at: Number.MAX_SAFE_INTEGER + 2 }, Infinity)).toThrow(CorruptDatabaseError);
    const flag = encodeMarks([{ start: k("a"), through: 2, at: 3 }]);
    flag[4 + 4 + 1] = 2;
    expect(() => decodeMarks(flag, 0, flag.byteLength, 9)).toThrow(CorruptDatabaseError);
  });
});
