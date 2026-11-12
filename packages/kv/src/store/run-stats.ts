import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import type { Marks, Seq } from "./marks.js";

/**
 * What a run holds, written by the encoder at the end of the run
 * (docs/sst-format.md, "Statistics") and copied into the manifest, so the
 * planner estimates dead bytes without reading a run.
 *
 * Entry bytes are key length plus value length; a tombstone's are its key.
 */
export type RunStats = {
  readonly entries: number;
  readonly entryBytes: number;
  readonly tombstones: number;
  readonly tombstoneBytes: number;
  /** Every entry, tombstones included. */
  readonly bySeq: Spread<Seq>;
  /** The puts with an expiry; empty when there are none. */
  readonly byExpiry: Spread<number>;
  /**
   * Every entry. Point 0 is the first key. Point j of 1 to 8 is the last key
   * of the first data block that ends with j/8 of the bytes behind it, so
   * point 8 is the last key.
   */
  readonly byKey: Spread<Uint8Array>;
};

/** A value on the axis, and the entry bytes of the entries at or below it. */
export type Point<A> = { readonly at: A; readonly through: number };

/**
 * Nine points, or none. On a numeric axis: the smallest value; for j of 1
 * to 7, the smallest value at or below which lie j/8 of the bytes; the
 * largest value.
 */
export type Spread<A> = readonly Point<A>[];

const POINTS = 9;

/**
 * Bytes on a numeric axis at or below `x`. The truth lies between the
 * point below `x` and the next level, a gap of at most 1/8 of the bytes, so
 * the midpoint is within 1/16 of them. Exact below the smallest value and
 * from the largest on.
 */
export function bytesAtOrBelow(spread: Spread<number>, x: number): number {
  const last = spread[POINTS - 1];
  if (!last || x < spread[0]!.at) return 0;
  if (x >= last.at) return last.through;
  let j = 0;
  while (spread[j + 1]!.at <= x) j++;
  const hi = Math.min(spread[j + 1]!.through, ((j + 1) * last.through) / 8);
  return (spread[j]!.through + hi) / 2;
}

/**
 * Bytes of the entries whose key sorts below `key`. The truth lies between
 * two neighbouring points, at most 1/8 of the bytes plus one data block
 * apart, so the midpoint is within 1/16 of the bytes plus half a block.
 * Exact at or below the first key and past the last.
 */
export function bytesBelowKey(spread: Spread<Uint8Array>, key: Uint8Array): number {
  const last = spread[POINTS - 1];
  if (!last || compareBytes(key, spread[0]!.at) <= 0) return 0;
  if (compareBytes(key, last.at) > 0) return last.through;
  let j = 0;
  while (compareBytes(spread[j + 1]!.at, key) < 0) j++;
  return (spread[j]!.through + spread[j + 1]!.through) / 2;
}

/** Entry bytes of the puts that expired at `now`. */
export function expiredBytes(stats: RunStats, now: number): number {
  return bytesAtOrBelow(stats.byExpiry, now);
}

/** What the covered estimate needs of a run. */
export type MarkedRun = { readonly stats: RunStats; readonly marksThrough: Seq };

/**
 * Entry bytes that a mark the run has not absorbed covers. Per piece, the
 * key share of its range times the seq share at or below its `through`:
 * key and seq are taken as independent within a run. The truth lies
 * between `max(0, k + s - total)` and `min(k, s)` for the piece's key bytes
 * `k` and seq bytes `s`, which are exact when the piece holds every key of
 * the run or every seq of it, the shape of most range deletes.
 */
export function coveredBytes(run: MarkedRun, marks: Marks): number {
  const { stats, marksThrough } = run;
  if (marks.empty) return 0;
  const total = stats.entryBytes;
  const first = stats.byKey[0]!.at;
  const last = stats.byKey[POINTS - 1]!.at;
  let covered = 0;
  marks.pieces.forEach((piece, i) => {
    if (piece.through === 0 || piece.at <= marksThrough) return;
    const end = marks.pieces[i + 1]?.start;
    if (compareBytes(piece.start, last) > 0 || (end && compareBytes(end, first) <= 0)) return;
    const keys = (end ? bytesBelowKey(stats.byKey, end) : total) - bytesBelowKey(stats.byKey, piece.start);
    const seqs = bytesAtOrBelow(stats.bySeq, piece.through);
    covered += total === 0 ? 0 : (Math.max(0, keys) * seqs) / total;
  });
  return Math.min(total, covered);
}

/**
 * Whether every entry of the run is covered: each piece over its key range
 * has a `through` at or past its largest seq. Never true when an entry is
 * not covered; false also when a piece that holds none of the run's keys
 * falls inside its range.
 */
export function whollyCovered(stats: RunStats, marks: Marks): boolean {
  if (marks.empty) return false;
  const first = stats.byKey[0]!.at;
  const last = stats.byKey[POINTS - 1]!.at;
  const maxSeq = stats.bySeq[POINTS - 1]!.at;
  return marks.pieces.every((piece, i) => {
    const end = marks.pieces[i + 1]?.start;
    const outside = compareBytes(piece.start, last) > 0 || (end !== undefined && compareBytes(end, first) <= 0);
    return outside || (piece.through > 0 && piece.through >= maxSeq);
  });
}

/**
 * Entry bytes of the run that a read at `now` under `marks` finds absent:
 * tombstones, expired puts and covered entries, the last two taken as
 * independent of each other.
 */
export function deadBytes(run: MarkedRun, marks: Marks, now: number): number {
  const { entryBytes, tombstoneBytes } = run.stats;
  if (entryBytes === 0) return 0;
  const gone = Math.min(entryBytes, tombstoneBytes + expiredBytes(run.stats, now));
  const covered = coveredBytes(run, marks);
  return Math.min(entryBytes, gone + covered * (1 - gone / entryBytes));
}

/**
 * The entry bytes of the manifest's runs that a read at `now` finds: the
 * runs' entry bytes less their dead bytes. Older versions of a key that a
 * newer run overwrote or deleted still count until a merge removes them.
 */
export function liveEntryBytes(meta: { readonly runs: readonly MarkedRun[]; readonly marks: Marks }, now: number): number {
  let live = 0;
  for (const run of meta.runs) live += run.stats.entryBytes - deadBytes(run, meta.marks, now);
  return live;
}

/**
 * The entry bytes of the manifest's runs written at or below `seq`: what a
 * range delete over every key through `seq` would cover.
 */
export function entryBytesThroughSeq(meta: { readonly runs: readonly MarkedRun[] }, seq: Seq): number {
  let bytes = 0;
  for (const { stats } of meta.runs) bytes += bytesAtOrBelow(stats.bySeq, seq);
  return bytes;
}

export function encodeStats(stats: RunStats): Uint8Array {
  let size = 16 + 3 + 12 * (stats.bySeq.length + stats.byExpiry.length);
  for (const p of stats.byKey) size += 8 + p.at.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  const u32 = (n: number) => {
    view.setUint32(o, n, true);
    o += 4;
  };
  for (const n of [stats.entries, stats.entryBytes, stats.tombstones, stats.tombstoneBytes]) u32(n);
  for (const spread of [stats.bySeq, stats.byExpiry]) {
    out[o++] = spread.length;
    for (const p of spread) {
      view.setBigUint64(o, BigInt(p.at), true);
      o += 8;
      u32(p.through);
    }
  }
  out[o++] = stats.byKey.length;
  for (const p of stats.byKey) {
    u32(p.at.byteLength);
    out.set(p.at, o);
    o += p.at.byteLength;
    u32(p.through);
  }
  return out;
}

/**
 * The statistics of a run with at least one entry, at `offset` of `bytes`
 * and ending exactly at `end`. Throws `CorruptDatabaseError` unless the
 * counts fit the entries, each spread has nine points in order whose bytes
 * end at the right total, and no seq passes `maxSeq`.
 */
export function decodeStats(bytes: Uint8Array, offset: number, end: number, maxSeq: Seq): RunStats {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = offset;
  const take = (n: number): number => {
    if (o + n > end) throw new CorruptDatabaseError("run stats truncated");
    o += n;
    return o - n;
  };
  const u32 = () => view.getUint32(take(4), true);
  const [entries, entryBytes, tombstones, tombstoneBytes] = [u32(), u32(), u32(), u32()];
  if (entries === 0 || tombstones > entries || tombstoneBytes > entryBytes) {
    throw new CorruptDatabaseError("run stats counts");
  }
  const numeric = (): Point<number>[] => {
    const points: Point<number>[] = [];
    const n = bytes[take(1)]!;
    for (let i = 0; i < n; i++) {
      const at = view.getBigUint64(take(8), true);
      if (at > BigInt(Number.MAX_SAFE_INTEGER)) throw new CorruptDatabaseError("run stats value out of range");
      points.push({ at: Number(at), through: u32() });
    }
    return points;
  };
  const bySeq = numeric();
  const byExpiry = numeric();
  const byKey: Point<Uint8Array>[] = [];
  const keys = bytes[take(1)]!;
  for (let i = 0; i < keys; i++) {
    const len = u32();
    const at = take(len);
    byKey.push({ at: bytes.slice(at, at + len), through: u32() });
  }
  if (o !== end) throw new CorruptDatabaseError("run stats trailing");
  const ordered = <A>(spread: Spread<A>, cmp: (a: A, b: A) => number, total: number | undefined) =>
    spread.every((p, i) => {
      const prev = spread[i - 1];
      return p.through <= entryBytes && (!prev || (cmp(prev.at, p.at) <= 0 && prev.through <= p.through));
    }) && (total === undefined || spread[spread.length - 1]?.through === total);
  const byNumber = (a: number, b: number) => a - b;
  if (
    bySeq.length !== POINTS ||
    byKey.length !== POINTS ||
    (byExpiry.length !== 0 && byExpiry.length !== POINTS) ||
    !ordered(bySeq, byNumber, entryBytes) ||
    !ordered(byExpiry, byNumber, undefined) ||
    !ordered(byKey, compareBytes, entryBytes) ||
    bySeq[POINTS - 1]!.at > maxSeq
  ) {
    throw new CorruptDatabaseError("run stats spread");
  }
  return { entries, entryBytes, tombstones, tombstoneBytes, bySeq, byExpiry, byKey };
}
