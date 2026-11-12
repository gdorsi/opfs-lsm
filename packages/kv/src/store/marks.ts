import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";

/**
 * The mark table: which rows range deletes removed. A mark is "every row in
 * [start, endExclusive) last written at a seq <= through is gone". The table
 * is the pointwise max of every mark folded so far, kept as a step function
 * over the key space rather than as a list, so lookup is one binary search
 * and join is commutative, associative and idempotent: replaying a record,
 * or folding records in any order, gives the same table.
 *
 * Marks block, the one encoding (manifest v4):
 *
 *   | u32 piece count  (>= 1)                                     |
 *   | per piece: u32 start length | start | u64 through | u64 at  |
 *
 * A reader rejects a count of 0, a first start that is not empty, starts
 * that do not strictly increase, two adjacent pieces with the same
 * (through, at), through 0 with at != 0, at <= through when through > 0,
 * and at past the manifest's `through`.
 */

export type Seq = number;

/** One step: covers [start, the next piece's start). */
export type Piece = {
  readonly start: Uint8Array;
  /** 0: no mark here. */
  readonly through: Seq;
  /**
   * The seq of the record whose mark set `through` here; the smallest when
   * several set the same `through`. A run with `marksThrough >= at` holds no
   * version this piece covers.
   */
  readonly at: Seq;
};

declare const marksBrand: unique symbol;

/**
 * Sorted, first start empty, adjacent pieces differ. Only this module builds
 * one, and it is never mutated, so a `view` pins it by reference.
 */
export type Marks = {
  readonly pieces: readonly Piece[];
  /** The one-piece table with through 0. */
  readonly empty: boolean;
  readonly [marksBrand]: true;
};

/** One range delete of a record, `through` resolved. */
export type Mark = {
  readonly start: Uint8Array;
  /** Undefined: to the end of the key space. */
  readonly endExclusive?: Uint8Array;
  readonly through: Seq;
  /** The seq of the record that holds it. Always > through. */
  readonly at: Seq;
};

const EMPTY_KEY: Uint8Array = new Uint8Array(0);

function marksOf(pieces: readonly Piece[]): Marks {
  return { pieces, empty: pieces.length === 1 && pieces[0]!.through === 0 } as Marks;
}

export const NO_MARKS: Marks = marksOf([{ start: EMPTY_KEY, through: 0, at: 0 }]);

/** Appends `piece`, merged into the last one when both say the same. */
function push(out: Piece[], start: Uint8Array, through: Seq, at: Seq): void {
  const last = out[out.length - 1];
  if (last && last.through === through && last.at === at) return;
  out.push({ start, through, at });
}

/** The table of a single mark. */
export function markTable(mark: Mark): Marks {
  if (mark.through === 0) return NO_MARKS;
  const out: Piece[] = mark.start.byteLength > 0 ? [{ start: EMPTY_KEY, through: 0, at: 0 }] : [];
  push(out, mark.start, mark.through, mark.at);
  if (mark.endExclusive) push(out, mark.endExclusive, 0, 0);
  return marksOf(out);
}

/** The larger `through` wins; on a tie, the smaller `at` (either mark suffices). */
function higher(a: Piece, b: Piece): Piece {
  if (a.through !== b.through) return a.through > b.through ? a : b;
  return a.at <= b.at ? a : b;
}

/** Pointwise max. Returns `a` or `b` itself when the other is empty. */
export function joinMarks(a: Marks, b: Marks): Marks {
  if (b.empty) return a;
  if (a.empty) return b;
  const pa = a.pieces;
  const pb = b.pieces;
  const out: Piece[] = [];
  let i = 0;
  let j = 0;
  let start: Uint8Array = EMPTY_KEY;
  for (;;) {
    const won = higher(pa[i]!, pb[j]!);
    push(out, start, won.through, won.at);
    const na = pa[i + 1];
    const nb = pb[j + 1];
    if (!na && !nb) break;
    const c = !na ? 1 : !nb ? -1 : compareBytes(na.start, nb.start);
    if (c <= 0) i++;
    if (c >= 0) j++;
    start = c <= 0 ? na!.start : nb!.start;
  }
  return marksOf(out);
}

/** The index of the piece holding `key`. */
function pieceAt(pieces: readonly Piece[], key: Uint8Array): number {
  let lo = 1;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareBytes(pieces[mid]!.start, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The highest `through` covering `key`. */
export function throughAt(marks: Marks, key: Uint8Array): Seq {
  return marks.empty ? 0 : marks.pieces[pieceAt(marks.pieces, key)]!.through;
}

/**
 * `throughAt` for keys that only increase, or only decrease with `reverse`.
 * Amortized O(1) per call.
 */
export type MarkCursor = { at(key: Uint8Array): Seq };

export function markCursor(marks: Marks, reverse = false): MarkCursor {
  const { pieces } = marks;
  if (marks.empty) return { at: () => 0 };
  let i = reverse ? pieces.length - 1 : 0;
  return reverse
    ? {
        at(key) {
          while (i > 0 && compareBytes(pieces[i]!.start, key) > 0) i--;
          return pieces[i]!.through;
        },
      }
    : {
        at(key) {
          while (i + 1 < pieces.length && compareBytes(pieces[i + 1]!.start, key) <= 0) i++;
          return pieces[i]!.through;
        },
      };
}

/** What retirement needs to know about a run. */
type RunMarkInfo = {
  readonly range?: { readonly smallest: Uint8Array; readonly largest: Uint8Array };
  /** Every mark with `at <= marksThrough` was applied when this run was written. */
  readonly marksThrough: Seq;
};

/**
 * Lowers to 0 every piece that no run of `runs` can still hold a covered
 * version for: each run that overlaps the piece has `marksThrough >= at`.
 * A reader of a manifest reads only its runs and rows past its `through`,
 * and those rows are past every piece's `at`, so the verdict does not change
 * for anything it can read.
 */
export function retireMarks(marks: Marks, runs: readonly RunMarkInfo[]): Marks {
  if (marks.empty) return marks;
  const { pieces } = marks;
  const out: Piece[] = [];
  let changed = false;
  pieces.forEach((piece, i) => {
    const end = pieces[i + 1]?.start;
    const blocked =
      piece.through > 0 &&
      runs.some(
        (run) =>
          run.marksThrough < piece.at &&
          run.range !== undefined &&
          compareBytes(run.range.largest, piece.start) >= 0 &&
          (end === undefined || compareBytes(run.range.smallest, end) < 0),
      );
    if (piece.through > 0 && !blocked) changed = true;
    if (blocked) push(out, piece.start, piece.through, piece.at);
    else push(out, piece.start, 0, 0);
  });
  return changed ? marksOf(out) : marks;
}

export function encodeMarks(marks: Marks): Uint8Array {
  let size = 4;
  for (const p of marks.pieces) size += 4 + p.start.byteLength + 16;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, marks.pieces.length, true);
  let o = 4;
  for (const p of marks.pieces) {
    view.setUint32(o, p.start.byteLength, true);
    out.set(p.start, o + 4);
    o += 4 + p.start.byteLength;
    view.setBigUint64(o, BigInt(p.through), true);
    view.setBigUint64(o + 8, BigInt(p.at), true);
    o += 16;
  }
  return out;
}

/**
 * The marks block at `offset` of `bytes`, which ends at `limit`. Throws
 * `CorruptDatabaseError` on any rule of the layout, or a piece whose `at`
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
  const u64 = (): number => {
    const n = view.getBigUint64(take(8), true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CorruptDatabaseError("marks seq out of range");
    return Number(n);
  };
  const count = view.getUint32(take(4), true);
  if (count === 0) throw new CorruptDatabaseError("marks with no piece");
  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(take(4), true);
    const at0 = take(len);
    const start = bytes.slice(at0, at0 + len);
    const through = u64();
    const at = u64();
    const prev = pieces[i - 1];
    if (prev ? compareBytes(prev.start, start) >= 0 : start.byteLength !== 0) {
      throw new CorruptDatabaseError("marks out of order");
    }
    if (prev && prev.through === through && prev.at === at) throw new CorruptDatabaseError("marks not coalesced");
    if (through === 0 ? at !== 0 : at <= through || at > maxAt) throw new CorruptDatabaseError("marks bad seq");
    pieces.push({ start, through, at });
  }
  return { marks: marksOf(pieces), end: o };
}
