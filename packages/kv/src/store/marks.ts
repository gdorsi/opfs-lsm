import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";

/**
 * The marks: which rows range deletes removed, as a flat unordered list. A
 * mark is "every row in [start, endExclusive) last written at a seq <=
 * through is gone". Lookup is the max `through` of the marks that hold the
 * key, so join is concatenation, and repeating a mark changes no answer.
 *
 * Marks block, the one encoding (manifest v4):
 *
 *   | u32 count (0 is valid)                                              |
 *   | per mark: u32 start length | start | u8 has end | (u32 end length   |
 *   |           | end) | u64 through | u64 at                              |
 *
 * A reader rejects truncation, a `has end` above 1, an end not above the
 * start, through 0, at <= through, and at past the manifest's `through`.
 */

export type Seq = number;

/** One range delete of a record, `through` resolved. */
export type Mark = {
  readonly start: Uint8Array;
  /** Undefined: to the end of the key space. */
  readonly endExclusive?: Uint8Array;
  /** Never 0. */
  readonly through: Seq;
  /** The seq of the record that holds it. Always > through. */
  readonly at: Seq;
};

/** Never mutated, so a `view` pins it by reference. */
export type Marks = readonly Mark[];

export const NO_MARKS: Marks = [];

/** The highest `through` of the marks holding `key`, 0 when none. */
export function throughAt(marks: Marks, key: Uint8Array): Seq {
  let max = 0;
  for (const m of marks) {
    if (
      m.through > max &&
      compareBytes(key, m.start) >= 0 &&
      (!m.endExclusive || compareBytes(key, m.endExclusive) < 0)
    ) {
      max = m.through;
    }
  }
  return max;
}

/** What retirement needs to know about a run. */
type RunMarkInfo = {
  readonly range?: { readonly smallest: Uint8Array; readonly largest: Uint8Array };
  /** Every mark with `at <= marksThrough` was applied when this run was written. */
  readonly marksThrough: Seq;
};

/**
 * Drops every mark that no run of `runs` can still hold a covered version
 * for: each run that overlaps its range has `marksThrough >= at`. A reader
 * of a manifest reads only its runs and rows past its `through`, and those
 * rows are past every mark's `at`, so the verdict does not change for
 * anything it can read. Returns `marks` itself when none retires.
 */
export function retireMarks(marks: Marks, runs: readonly RunMarkInfo[]): Marks {
  const kept = marks.filter((m) =>
    runs.some(
      (run) =>
        run.marksThrough < m.at &&
        run.range !== undefined &&
        compareBytes(run.range.largest, m.start) >= 0 &&
        (!m.endExclusive || compareBytes(run.range.smallest, m.endExclusive) < 0),
    ),
  );
  return kept.length === marks.length ? marks : kept;
}

export function encodeMarks(marks: Marks): Uint8Array {
  let size = 4;
  for (const m of marks) size += 4 + m.start.byteLength + 1 + (m.endExclusive ? 4 + m.endExclusive.byteLength : 0) + 16;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, marks.length, true);
  let o = 4;
  const bytes = (b: Uint8Array): void => {
    view.setUint32(o, b.byteLength, true);
    out.set(b, o + 4);
    o += 4 + b.byteLength;
  };
  for (const m of marks) {
    bytes(m.start);
    out[o++] = m.endExclusive ? 1 : 0;
    if (m.endExclusive) bytes(m.endExclusive);
    view.setBigUint64(o, BigInt(m.through), true);
    view.setBigUint64(o + 8, BigInt(m.at), true);
    o += 16;
  }
  return out;
}

/**
 * The marks block at `offset` of `bytes`, which ends at `limit`. Throws
 * `CorruptDatabaseError` on any rule of the layout, or a mark whose `at`
 * passes `maxAt`.
 */
export function decodeMarks(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  maxAt: Seq,
): { readonly marks: Marks; readonly end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = offset;
  const take = (n: number): number => {
    if (o + n > limit) throw new CorruptDatabaseError("marks truncated");
    o += n;
    return o - n;
  };
  const key = (): Uint8Array => {
    const len = view.getUint32(take(4), true);
    const at = take(len);
    return bytes.slice(at, at + len);
  };
  const u64 = (): number => {
    const n = view.getBigUint64(take(8), true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CorruptDatabaseError("marks seq out of range");
    return Number(n);
  };
  const marks: Mark[] = [];
  for (let n = view.getUint32(take(4), true); n > 0; n--) {
    const start = key();
    const hasEnd = bytes[take(1)]!;
    if (hasEnd > 1) throw new CorruptDatabaseError("marks bad end flag");
    const endExclusive = hasEnd ? key() : undefined;
    if (endExclusive && compareBytes(endExclusive, start) <= 0) throw new CorruptDatabaseError("marks empty range");
    const through = u64();
    const at = u64();
    if (through === 0 || at <= through || at > maxAt) throw new CorruptDatabaseError("marks bad seq");
    marks.push(endExclusive ? { start, endExclusive, through, at } : { start, through, at });
  }
  return { marks, end: o };
}
