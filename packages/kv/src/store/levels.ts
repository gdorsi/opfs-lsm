import { compareBytes } from "../bytes.js";
import type { RunMeta } from "./generation.js";
import type { KeyRange, SstCodec } from "./sst.js";

/**
 * Leveled layout. A generation lists the L0 runs newest first, then each
 * level's runs in key order. L0 runs may overlap each other. Runs in one
 * level from L1 down never overlap. Each run's level is in its path and its
 * byte size and key range are in the manifest, so planning reads no files.
 */
const L0_RUNS_TO_COMPACT = 4;
/**
 * A step holds a window of each source, so its memory grows with the
 * source count and not with the inputs' size. L0 runs past this many wait
 * for the next step.
 */
const MAX_SOURCES = 16;
const LEVEL_RATIO = 10;
/** Ten compaction-sized runs (`TARGET_RUN_BYTES`). */
const L1_TARGET_BYTES = 40 * 1024 * 1024;
/** Compaction cuts its output into runs of about this size. */
export const TARGET_RUN_BYTES = 4 * 1024 * 1024;

/**
 * L0 and L1 hold the recent writes and stay raw to keep reading them fast.
 * An LZ4 block costs a decompress on every read. A get pays about 70% more
 * and a 256-row page about 25% more. Runs from L2 down hold nearly all the
 * data, so LZ4 saves the most memory there. Encode cost is not the reason.
 * A 4.3 MB flush run encodes in about the same time raw or LZ4.
 */
export function codecForLevel(level: number): SstCodec {
  return level >= 2 ? "lz4" : "raw";
}

export type CompactionPlan = {
  /**
   * Newest first. A source is runs a merge reads back to back as one
   * key-ordered stream: each L0 run alone, and the overlapped runs of the
   * level below together, since they do not overlap each other.
   */
  readonly sources: readonly (readonly RunMeta[])[];
  /** The runs of `sources`, in manifest order, so newest first. */
  readonly inputs: readonly RunMeta[];
  readonly outputLevel: number;
  /** No run below the output level overlaps the inputs, so tombstones have nothing left to hide. */
  readonly bottom: boolean;
};

/** 0 for L0, n for Ln. Undefined when the path has no `l<n>/` prefix. */
export function levelOf(path: string): number | undefined {
  const m = /^l(\d+)\//.exec(path);
  return m ? Number(m[1]) : undefined;
}

export function levelRunPath(level: number, name: string): string {
  return `l${level}/${name}.sst`;
}

/** A missing range is unbounded. */
function overlaps(a: KeyRange | undefined, b: KeyRange | undefined): boolean {
  if (!a || !b) return true;
  return compareBytes(a.smallest, b.largest) <= 0 && compareBytes(b.smallest, a.largest) <= 0;
}

function span(runs: readonly RunMeta[]): KeyRange | undefined {
  let out: KeyRange | undefined;
  for (const { range } of runs) {
    if (!range) return undefined;
    out = out
      ? {
          smallest: compareBytes(range.smallest, out.smallest) < 0 ? range.smallest : out.smallest,
          largest: compareBytes(range.largest, out.largest) > 0 ? range.largest : out.largest,
        }
      : range;
  }
  return out;
}

function bytesOf(runs: readonly RunMeta[]): number {
  return runs.reduce((n, r) => n + r.bytes, 0);
}

/** The next compaction step, or undefined when the layout is in shape. */
export function planCompaction(
  runs: readonly RunMeta[],
  l1Target = L1_TARGET_BYTES,
): CompactionPlan | undefined {
  const inLevel = (level: number | undefined) =>
    runs.filter((r) => levelOf(r.path) === level);
  const plan = (sources: RunMeta[][], outputLevel: number): CompactionPlan => {
    const taken = sources.filter((s) => s.length > 0);
    const inputs = taken.flat();
    const range = span(inputs);
    const below = runs.filter((r) => {
      const level = levelOf(r.path);
      return (level === undefined || level > outputLevel) && !inputs.includes(r);
    });
    return {
      sources: taken,
      inputs,
      outputLevel,
      bottom: !below.some((r) => overlaps(r.range, range)),
    };
  };

  // The level furthest over its target goes first. If L0 always won, L1
  // would grow past its target and every L0 merge would rewrite all of it.
  const l0 = inLevel(0);
  let best = { level: -1, score: 0 };
  if (l0.length >= L0_RUNS_TO_COMPACT) best = { level: 0, score: l0.length / L0_RUNS_TO_COMPACT };
  const deepest = Math.max(0, ...runs.map((r) => levelOf(r.path) ?? 0));
  for (let level = 1; level <= deepest; level++) {
    const score = bytesOf(inLevel(level)) / (l1Target * LEVEL_RATIO ** (level - 1));
    if (score > 1 && score > best.score) best = { level, score };
  }

  if (best.level === 0) {
    // The oldest ones, so the L0 runs left behind stay newer than L1.
    const taken = l0.slice(-(MAX_SOURCES - 1));
    const range = span(taken);
    return plan([...taken.map((r) => [r]), inLevel(1).filter((r) => overlaps(r.range, range))], 1);
  }
  if (best.level < 0) return undefined;
  const files = inLevel(best.level);
  const next = inLevel(best.level + 1);
  const cost = (r: RunMeta) =>
    bytesOf(next.filter((n) => overlaps(n.range, r.range))) / Math.max(1, r.bytes);
  const pick = files.reduce((a, r) => (cost(r) < cost(a) ? r : a));
  return plan([[pick], next.filter((n) => overlaps(n.range, pick.range))], best.level + 1);
}

/**
 * `runs` without `inputs` and with `outputs`, in manifest order: L0 as it
 * was, then each level by smallest key.
 */
export function replaceRuns(
  runs: readonly RunMeta[],
  inputs: readonly string[],
  outputs: readonly RunMeta[],
): RunMeta[] {
  const kept = runs.filter((r) => !inputs.includes(r.path));
  const l0 = kept.filter((r) => levelOf(r.path) === 0);
  const leveled = [...kept.filter((r) => levelOf(r.path) !== 0), ...outputs];
  const rank = (r: RunMeta) => levelOf(r.path) ?? Number.POSITIVE_INFINITY;
  leveled.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (!a.range || !b.range) return 0;
    return compareBytes(a.range.smallest, b.range.smallest);
  });
  return [...l0, ...leveled];
}
