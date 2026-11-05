import { compareBytes } from "../bytes.js";
import type { KeyRange, RunMeta } from "./generation.js";
import type { SstCodec } from "./sst.js";

/**
 * Leveled layout. A generation lists the L0 runs newest first, then each
 * level's runs in key order. L0 runs may overlap each other. Runs in one
 * level from L1 down never overlap. Each run's level and byte size are in
 * its path and its key range is in the manifest, so planning reads no files.
 */
export const L0_RUNS_TO_COMPACT = 4;
export const LEVEL_RATIO = 10;
/** Ten flushes of the default 4 MiB memtable. */
export const L1_TARGET_BYTES = 40 * 1024 * 1024;
/** Compaction cuts its output into runs of about this size. */
export const TARGET_RUN_BYTES = 4 * 1024 * 1024;

/**
 * Runs from L2 down hold nearly all the data and are rewritten only by
 * compaction, so they pay LZ4's encode cost off the flush path. L0 and L1
 * hold the recent writes and stay raw.
 */
export function codecForLevel(level: number): SstCodec {
  return level >= 2 ? "lz4" : "raw";
}

export type CompactionPlan = {
  /** In manifest order, so newest first. */
  readonly inputs: readonly RunMeta[];
  readonly outputLevel: number;
  /** No run below the output level overlaps the inputs, so tombstones have nothing left to hide. */
  readonly bottom: boolean;
};

/** 0 for L0, n for Ln, undefined for runs written before levels existed. */
export function levelOf(path: string): number | undefined {
  const m = /^l(\d+)\//.exec(path);
  return m ? Number(m[1]) : undefined;
}

export function sizeOf(path: string): number {
  const m = /-(\d+)\.sst$/.exec(path);
  return m ? Number(m[1]) : 0;
}

export function levelRunPath(level: number, name: string, bytes: number): string {
  return `l${level}/${name}-${bytes}.sst`;
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
  return runs.reduce((n, r) => n + sizeOf(r.path), 0);
}

/** The next compaction step, or undefined when the layout is in shape. */
export function planCompaction(
  runs: readonly RunMeta[],
  l1Target = L1_TARGET_BYTES,
): CompactionPlan | undefined {
  const inLevel = (level: number | undefined) =>
    runs.filter((r) => levelOf(r.path) === level);
  const plan = (inputs: RunMeta[], outputLevel: number): CompactionPlan => {
    const range = span(inputs);
    const below = runs.filter((r) => {
      const level = levelOf(r.path);
      return (level === undefined || level > outputLevel) && !inputs.includes(r);
    });
    return {
      inputs: runs.filter((r) => inputs.includes(r)),
      outputLevel,
      bottom: !below.some((r) => overlaps(r.range, range)),
    };
  };

  const legacy = inLevel(undefined);
  if (legacy.length > 0) {
    const deeper = runs.filter((r) => levelOf(r.path) !== 0);
    const deepest = Math.max(1, ...deeper.map((r) => levelOf(r.path) ?? 0));
    return plan(deeper, deepest);
  }

  const l0 = inLevel(0);
  if (l0.length >= L0_RUNS_TO_COMPACT) {
    const range = span(l0);
    return plan([...l0, ...inLevel(1).filter((r) => overlaps(r.range, range))], 1);
  }

  const deepest = Math.max(0, ...runs.map((r) => levelOf(r.path) ?? 0));
  for (let level = 1; level <= deepest; level++) {
    const files = inLevel(level);
    if (bytesOf(files) <= l1Target * LEVEL_RATIO ** (level - 1)) continue;
    const next = inLevel(level + 1);
    const cost = (r: RunMeta) =>
      bytesOf(next.filter((n) => overlaps(n.range, r.range))) / Math.max(1, sizeOf(r.path));
    const pick = files.reduce((best, r) => (cost(r) < cost(best) ? r : best));
    return plan([pick, ...next.filter((n) => overlaps(n.range, pick.range))], level + 1);
  }
  return undefined;
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
