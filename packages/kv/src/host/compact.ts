import type { AsyncFs } from "../opfs/async-fs.js";
import { newestIntact } from "../recover.js";
import { mergeSsts } from "../store/engine.js";
import {
  loadLatestGeneration,
  manifestNumbers,
  publishGeneration,
  publishRun,
  type GenerationMeta,
  type RunMeta,
} from "../store/generation.js";
import {
  codecForLevel,
  levelRunPath,
  planCompaction,
  replaceRuns,
  TARGET_RUN_BYTES,
} from "../store/levels.js";

/** Merged runs written to OPFS and not yet in any generation. */
export type CompactionOutput = {
  readonly inputs: readonly string[];
  readonly outputs: readonly RunMeta[];
  readonly droppedSeq: number;
};

/**
 * Plan one step on `base` (the recorded generation; the newest manifest
 * file when omitted), merge its inputs, and write the output run. Needs no
 * ingest lock: a flush meanwhile only adds L0 runs in front of the inputs,
 * which stay contiguous and keep their bottom status. Outputs are named
 * past every manifest number in use (`knownTop`, IndexedDB's
 * `topGeneration`, and `m/`), so they never overwrite a run one may list.
 */
export async function mergeNextStep(
  fs: AsyncFs,
  base?: GenerationMeta,
  knownTop = 0,
): Promise<CompactionOutput | undefined> {
  const meta = base ?? (await loadLatestGeneration(fs));
  if (!meta) return undefined;
  const top = Math.max(meta.generation, knownTop, (await manifestNumbers(fs))[0] ?? 0);
  const plan = planCompaction(meta.runs);
  if (!plan) return undefined;

  const blobs: Uint8Array[] = [];
  for (const { path } of plan.inputs) {
    const buf = await fs.read(path, 0, Number.POSITIVE_INFINITY);
    if (!buf) throw new Error(`compaction missing input ${path}`);
    blobs.push(buf);
  }
  const { runs, droppedSeq } = await mergeSsts(
    blobs,
    plan.bottom,
    TARGET_RUN_BYTES,
    codecForLevel(plan.outputLevel),
  );
  const outputs: RunMeta[] = [];
  for (const [i, run] of runs.entries()) {
    const path = levelRunPath(plan.outputLevel, `c${top + 1}.${i}`);
    await publishRun(fs, path, run.body);
    outputs.push({ path, ...run.end });
  }
  return { inputs: plan.inputs.map((r) => r.path), outputs, droppedSeq };
}

/**
 * Swap the step's inputs for its outputs in the newest intact manifest and
 * publish the result past every manifest number in use. Run under the
 * ingest lock. The inputs and the old manifests stay on disk: tabs may
 * still read them, and recovery may fall back to a kept manifest, so the
 * host reclaims them later. The queue cursors and `through` carry over:
 * the runs still hold the same records.
 */
export async function installMerged(fs: AsyncFs, step: CompactionOutput): Promise<number> {
  const { base, top } = await newestIntact(fs);
  const live = new Set(base.runs.map((r) => r.path));
  if (!step.inputs.every((p) => live.has(p))) {
    throw new Error("compaction inputs left the newest manifest");
  }
  const generation = top + 1;
  await publishGeneration(fs, {
    generation,
    runs: replaceRuns(base.runs, step.inputs, step.outputs),
    tombstoneSeq: Math.max(base.tombstoneSeq, step.droppedSeq),
    through: base.through,
    ...(base.queues && { queues: base.queues }),
  });
  return generation;
}
