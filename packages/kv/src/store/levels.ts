import { compareBytes } from "../bytes.js";
import type { GenerationMeta, RunMeta } from "./generation.js";
import { unabsorbed, type Marks } from "./marks.js";
import { coveredBytes, deadBytes, expiredBytes, whollyCovered } from "./run-stats.js";
import type { KeyRange, SstCodec } from "./sst.js";

/**
 * Leveled layout. A generation lists the L0 runs newest first, then each
 * level's runs in key order. L0 runs may overlap each other. Runs in one
 * level from L1 down never overlap. Each run's level is in its path and its
 * byte size and key range are in the manifest, so planning reads no files.
 */
const L0_RUNS_TO_COMPACT = 4;
const LEVEL_RATIO = 10;
/** Ten compaction-sized runs (`TARGET_RUN_BYTES`). */
export const L1_TARGET_BYTES = 40 * 1024 * 1024;
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

/**
 * One compaction step. A merge reads its sources and writes the output
 * level's runs in place of its inputs. A drop removes runs a range delete
 * wholly covers, and writes nothing.
 */
export type CompactionPlan =
  | {
      readonly kind: "merge";
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
    }
  | { readonly kind: "drop"; readonly inputs: readonly RunMeta[] };

export type MergePlan = Extract<CompactionPlan, { kind: "merge" }>;

/** n for an `l<n>` directory name, undefined for any other name. */
export function levelOfDir(dir: string): number | undefined {
  const m = /^l(\d+)$/.exec(dir);
  return m ? Number(m[1]) : undefined;
}

/** 0 for L0, n for Ln. Undefined when the path has no `l<n>/` prefix. */
export function levelOf(path: string): number | undefined {
  const slash = path.indexOf("/");
  return slash < 0 ? undefined : levelOfDir(path.slice(0, slash));
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

type PlanLimits = {
  /**
   * The most sources a step reads. A step holds a window of each, so its
   * memory grows with the source count and not with the inputs' size. L0
   * runs past `maxSources - 1` wait for the next step.
   */
  readonly maxSources: number;
  /** Bytes of L1 past which it compacts into L2. */
  readonly l1Target?: number;
};

/**
 * A run is rewritten though its level is in shape once this share of it is
 * dead: of its entry bytes, those a read finds absent, or of its entries,
 * the tombstones. By bytes, the rewrite writes at most twice what it frees.
 * A tombstone frees little itself; it stands for the version it hides
 * below, which only a merge that reaches it frees.
 */
const DEAD_SHARE_TO_REWRITE = 1 / 2;

/** Shares of `run`: dead entry bytes, covered entry bytes, expired entry bytes, and tombstones by count. */
function deadShares(run: RunMeta, marks: Marks, now: number) {
  const { entryBytes, entries, tombstones } = run.stats;
  const bytes = Math.max(1, entryBytes);
  return {
    dead: deadBytes(run, marks, now) / bytes,
    covered: coveredBytes(run, marks) / bytes,
    expired: expiredBytes(run.stats, now) / bytes,
    tombstones: tombstones / entries,
  };
}

/**
 * The next compaction step on the manifest at `now`, or undefined when the
 * layout is in shape, no run is half dead, and every run has absorbed the
 * marks over it. In order:
 *
 * 1. Drop the runs a mark wholly covers. Costs no merge.
 * 2. The level furthest over its target, as one step.
 * 3. The run with the largest dead share at or past `DEAD_SHARE_TO_REWRITE`.
 *    At the bottom it is rewritten alone, which drops its tombstones and
 *    expired puts. Above, a run dead mostly by marks is rewritten alone,
 *    which drops what they cover and turns its expired puts to tombstones;
 *    one dead mostly by tombstones or expired puts goes down with the runs
 *    it overlaps in the next level, toward the versions they hide. An L0
 *    run counts only its expired and covered bytes, and takes the L0 step.
 * 4. The run a mark covers most, among those that have not absorbed a mark
 *    over them; a mark retires only once every run under it absorbed it.
 *
 * Every step makes progress: a drop or a merge into a deeper level removes
 * runs or moves bytes down, and a rewrite in place leaves outputs with no
 * expired put and no unabsorbed mark, so they come back only as runs pushed
 * down. So the steps end without new writes.
 */
export function planCompaction(
  { runs, marks }: Pick<GenerationMeta, "runs" | "marks">,
  now: number,
  { maxSources, l1Target = L1_TARGET_BYTES }: PlanLimits,
): CompactionPlan | undefined {
  const dropped = runs.filter((r) => levelOf(r.path) !== undefined && whollyCovered(r.stats, marks));
  if (dropped.length > 0) return { kind: "drop", inputs: dropped };

  const inLevel = (level: number | undefined) =>
    runs.filter((r) => levelOf(r.path) === level);
  const plan = (sources: RunMeta[][], outputLevel: number): MergePlan => {
    const taken = sources.filter((s) => s.length > 0);
    const inputs = taken.flat();
    const range = span(inputs);
    const below = runs.filter((r) => {
      const level = levelOf(r.path);
      return (level === undefined || level > outputLevel) && !inputs.includes(r);
    });
    return {
      kind: "merge",
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

  const l0Step = () => {
    // The oldest ones, so the L0 runs left behind stay newer than L1.
    const taken = l0.slice(-(maxSources - 1));
    const range = span(taken);
    return plan([...taken.map((r) => [r]), inLevel(1).filter((r) => overlaps(r.range, range))], 1);
  };
  /** `run` with the runs it overlaps in the next level. */
  const pushDown = (run: RunMeta, level: number) =>
    plan([[run], inLevel(level + 1).filter((n) => overlaps(n.range, run.range))], level + 1);
  if (best.level === 0) return l0Step();
  if (best.level > 0) {
    const files = inLevel(best.level);
    const next = inLevel(best.level + 1);
    const cost = (r: RunMeta) =>
      bytesOf(next.filter((n) => overlaps(n.range, r.range))) / Math.max(1, r.bytes);
    return pushDown(files.reduce((a, r) => (cost(r) < cost(a) ? r : a)), best.level);
  }

  const leveled = runs.filter((r) => levelOf(r.path) !== undefined);
  // An L0 run's tombstones wait for the L0 step: a delete-heavy flush
  // would otherwise rewrite the L1 runs it overlaps at every flush.
  const dead = leveled
    .map((run) => ({ run, ...deadShares(run, marks, now) }))
    .map((d) => ({ ...d, share: levelOf(d.run.path) === 0 ? d.covered + d.expired : Math.max(d.dead, d.tombstones) }))
    .filter((d) => d.share >= DEAD_SHARE_TO_REWRITE)
    .reduce<{ run: RunMeta; covered: number; tombstones: number; expired: number; share: number } | undefined>(
      (a, d) => (a && a.share >= d.share ? a : d),
      undefined,
    );
  if (dead) {
    const level = levelOf(dead.run.path)!;
    if (level === 0) return l0Step();
    const alone = plan([[dead.run]], level);
    if (alone.bottom || dead.covered >= Math.max(dead.expired, dead.tombstones)) return alone;
    return pushDown(dead.run, level);
  }

  const stale = leveled
    .filter((r) => unabsorbed(marks, r))
    .map((run) => ({ run, covered: coveredBytes(run, marks) }))
    .reduce<{ run: RunMeta; covered: number } | undefined>((a, s) => (a && a.covered >= s.covered ? a : s), undefined);
  if (!stale) return undefined;
  const level = levelOf(stale.run.path)!;
  return level === 0 ? l0Step() : plan([[stale.run]], level);
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
