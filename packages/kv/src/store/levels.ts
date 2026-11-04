/**
 * Leveled layout. A generation lists runs newest first: the L0 runs, then
 * one run per level, L1 down to Ln. Each run's byte size is in its name, so
 * planning reads no files.
 */
export const L0_RUNS_TO_COMPACT = 4;
export const LEVEL_RATIO = 10;
/** Ten flushes of the default 4 MiB memtable. */
export const L1_TARGET_BYTES = 40 * 1024 * 1024;

export type CompactionPlan = {
  /** Contiguous in the newest-first run list. */
  readonly inputs: readonly string[];
  readonly outputLevel: number;
  /** The inputs include the oldest run, so tombstones have nothing left to hide. */
  readonly bottom: boolean;
};

/** 0 for L0, n for Ln, undefined for runs written before levels existed. */
export function levelOf(path: string): number | undefined {
  const m = /^l(\d+)\//.exec(path);
  return m ? Number(m[1]) : undefined;
}

function sizeOf(path: string): number {
  const m = /-(\d+)\.sst$/.exec(path);
  return m ? Number(m[1]) : 0;
}

export function levelRunPath(level: number, name: string, bytes: number): string {
  return `l${level}/${name}-${bytes}.sst`;
}

/** The next compaction step, or undefined when the layout is in shape. */
export function planCompaction(
  runs: readonly string[],
  l1Target = L1_TARGET_BYTES,
): CompactionPlan | undefined {
  const plan = (inputs: string[], outputLevel: number): CompactionPlan => ({
    inputs,
    outputLevel,
    bottom: inputs.includes(runs[runs.length - 1]!),
  });
  const deeper = runs.filter((p) => levelOf(p) !== 0);
  if (deeper.some((p) => levelOf(p) === undefined)) {
    const deepest = Math.max(1, ...deeper.map((p) => levelOf(p) ?? 0));
    return plan(deeper, deepest);
  }
  const l0 = runs.filter((p) => levelOf(p) === 0);
  if (l0.length >= L0_RUNS_TO_COMPACT) {
    const l1 = deeper.find((p) => levelOf(p) === 1);
    return plan(l1 ? [...l0, l1] : l0, 1);
  }
  for (const run of deeper) {
    const level = levelOf(run)!;
    if (sizeOf(run) <= l1Target * LEVEL_RATIO ** (level - 1)) continue;
    const next = deeper.find((p) => levelOf(p) === level + 1);
    return plan(next ? [run, next] : [run], level + 1);
  }
  return undefined;
}

/** `runs` with the contiguous `inputs` replaced by `output`. */
export function replaceRuns(
  runs: readonly string[],
  inputs: readonly string[],
  output: string | undefined,
): string[] {
  const at = runs.indexOf(inputs[0]!);
  const rest = runs.filter((p) => !inputs.includes(p));
  if (output !== undefined) rest.splice(at, 0, output);
  return rest;
}
