import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import type { Seq } from "./marks.js";

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
