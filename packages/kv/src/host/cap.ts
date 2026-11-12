import type { GenerationMeta, RunMeta } from "../store/generation.js";
import { levelOf, overlaps } from "../store/levels.js";
import { bytesAtOrBelow, coveredBytes, deadBytes, expiredBytes, liveEntryBytes } from "../store/run-stats.js";

/** What the host measured over `maxBytes`, offered to the one tab that answers. */
export type Pressure = {
  /** Estimated entry bytes (key plus value lengths) that reads find in the run files of the recorded manifest. */
  readonly liveBytes: number;
  /** The cap the host holds: the smallest `maxBytes` any open tab passed, at least the floor. */
  readonly maxBytes: number;
  /** Entry bytes to remove to come back to `CAP_TARGET` of `maxBytes`. */
  readonly need: number;
  /** Removing every row last written at or before this seq frees about `need`. Never past the manifest's `through`. */
  readonly through: number;
};

export type Offer = { readonly id: string; readonly pressure: Pressure };

/** An answer aims below the cap, so a database at the edge is not offered again at every flush. */
const CAP_TARGET = 7 / 8;

/**
 * The host's offer for one database. Not stored: a new host starts idle and
 * measures again.
 *
 * - `offered`: broadcast, no answer yet. Re-sent to a tab that takes the
 *   pressure lock. Its numbers follow each measurement.
 * - `answered`: a tab's handlers settled. What they removed is counted once
 *   the manifest reaches `head`, the WAL head when the answer arrived, and a
 *   compaction pass numbered above `pass` measured it.
 */
export type OfferState =
  | { readonly kind: "idle" }
  | ({ readonly kind: "offered" } & Offer)
  | { readonly kind: "answered"; readonly head: number; readonly pass: number };

export const IDLE: OfferState = { kind: "idle" };

export type Measurement = {
  readonly meta: Pick<GenerationMeta, "runs" | "marks" | "through">;
  readonly now: number;
  readonly maxBytes: number;
  /** The number of the compaction pass that measures. */
  readonly pass: number;
  /** The id a new offer takes. */
  readonly id: string;
};

/**
 * The next offer state after a compaction pass, and the offer to broadcast
 * if there is a new one. One offer is open at a time, and an answer is
 * judged only once its writes are in the manifest.
 */
export function decideCap(state: OfferState, m: Measurement): { readonly next: OfferState; readonly post?: Offer } {
  if (state.kind === "answered" && (m.meta.through < state.head || m.pass <= state.pass)) return { next: state };
  const liveBytes = capLiveBytes(m.meta, m.now);
  if (liveBytes <= m.maxBytes) return { next: IDLE };
  const need = Math.ceil(liveBytes - m.maxBytes * CAP_TARGET);
  const pressure = { liveBytes: Math.round(liveBytes), maxBytes: m.maxBytes, need, through: seqFreeing(m.meta, m.now, need) };
  if (state.kind === "offered") return { next: { ...state, pressure } };
  const post = { id: m.id, pressure };
  return { next: { kind: "offered", ...post }, post };
}

/** The state once the tab that holds the lock answered `id`. An answer to an offer no longer open changes nothing. */
export function answerOffer(state: OfferState, id: string, head: number, pass: number): OfferState {
  return state.kind === "offered" && state.id === id ? { kind: "answered", head, pass } : state;
}

/**
 * Live entry bytes less the versions the manifest's tombstones hide, so a
 * delete counts as soon as it is flushed, not when a merge reaches the
 * version it hides.
 */
function capLiveBytes(meta: Pick<GenerationMeta, "runs" | "marks">, now: number): number {
  return Math.max(0, liveEntryBytes(meta, now) - shadowedBytes(meta, now));
}

/**
 * Entry bytes of older versions that tombstones hide. Each tombstone is
 * taken to hide one put of the mean put size, in an older run its range
 * overlaps, and never more than those runs hold live.
 */
function shadowedBytes({ runs, marks }: Pick<GenerationMeta, "runs" | "marks">, now: number): number {
  let puts = 0;
  let putBytes = 0;
  for (const { stats } of runs) {
    puts += stats.entries - stats.tombstones;
    putBytes += stats.entryBytes - stats.tombstoneBytes;
  }
  if (puts === 0) return 0;
  const mean = putBytes / puts;
  const live = (r: RunMeta) => r.stats.entryBytes - deadBytes(r, marks, now);
  let hidden = 0;
  runs.forEach((run, i) => {
    if (run.stats.tombstones === 0) return;
    const level = levelOf(run.path) ?? 0;
    let below = 0;
    runs.forEach((older, j) => {
      const olderLevel = levelOf(older.path) ?? 0;
      const isOlder = level === 0 ? (olderLevel === 0 ? j > i : true) : olderLevel > level;
      if (isOlder && overlaps(older.range, run.range)) below += live(older);
    });
    hidden += Math.min(run.stats.tombstones * mean, below);
  });
  return hidden;
}

/**
 * Live entry bytes written at or below `seq`, each run's tombstones and
 * expired puts taken as spread evenly over its seqs.
 */
function liveThrough({ runs, marks }: Pick<GenerationMeta, "runs" | "marks">, now: number, seq: number): number {
  let live = 0;
  for (const run of runs) {
    const { entryBytes, tombstoneBytes } = run.stats;
    if (entryBytes === 0) continue;
    const gone = Math.min(entryBytes, tombstoneBytes + expiredBytes(run.stats, now)) / entryBytes;
    const written = bytesAtOrBelow(run.stats.bySeq, seq);
    live += Math.max(0, written - coveredBytes(run, marks, seq)) * (1 - gone);
  }
  return live;
}

/**
 * The smallest seq of a run statistic point through which `need` live bytes
 * were written, or the manifest's `through`. The estimate only changes at
 * those points.
 */
function seqFreeing(meta: Pick<GenerationMeta, "runs" | "marks" | "through">, now: number, need: number): number {
  const points = [...new Set(meta.runs.flatMap((r) => r.stats.bySeq.map((p) => p.at)))].sort((a, b) => a - b);
  return points.find((seq) => liveThrough(meta, now, seq) >= need) ?? meta.through;
}
