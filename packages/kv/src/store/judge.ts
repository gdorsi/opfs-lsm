import { throughAt, type MarkCursor, type Marks, type Seq } from "./marks.js";

/**
 * What one operation judges rows against. Taken once per operation, in the
 * same synchronous turn that captures the installed levels, and kept across
 * every Miss retry and every key. A `view` pins it.
 */
export type ReadPoint = {
  /** Epoch ms. A put whose `expiresAt` is at or before it reads as absent. */
  readonly now: number;
  /** join(installed manifest's marks, memtable's marks). */
  readonly marks: Marks;
};

/** The fields of a version the rule reads. */
export type Version = {
  readonly kind: "put" | "del";
  readonly key: Uint8Array;
  readonly seq: Seq;
  readonly expiresAt?: number;
};

/**
 * Whether a put with this expiry reads as absent at `at.now`. A flush or a
 * merge that is not at the bottom writes such a put as a tombstone with its
 * seq, because older versions of the key may live longer.
 */
export function expired(v: { readonly expiresAt?: number }, at: { readonly now: number }): boolean {
  return v.expiresAt !== undefined && v.expiresAt <= at.now;
}

/**
 * Whether the newest version of a key reads as absent: a delete, an expired
 * put, or one a mark covers. Applied only after the memtable, the level
 * order or the merge heap chose that version, so an expired put hides the
 * older ones as a delete would. A covered newest version means every older
 * one is covered too, since they have the same key and smaller seqs.
 * `cursor` replaces the binary search in key-ordered scans.
 */
export function dead(v: Version, at: ReadPoint, cursor?: MarkCursor): boolean {
  if (v.kind === "del" || expired(v, at)) return true;
  if (at.marks.empty) return false;
  return v.seq <= (cursor ? cursor.at(v.key) : throughAt(at.marks, v.key));
}
