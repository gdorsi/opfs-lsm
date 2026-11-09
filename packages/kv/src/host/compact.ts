import type { AsyncFs } from "../opfs/async-fs.js";
import { recoverGeneration } from "../recover.js";
import { mergeSsts } from "../store/engine.js";
import {
  loadLatestGeneration,
  manifestNumbers,
  publishGeneration,
  publishRun,
  runMeta,
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
 * Plan one step on `base` (the committed generation; the newest manifest
 * file when omitted), merge its inputs, and write the output run. Needs no
 * ingest lock: a flush meanwhile only adds L0 runs in front of the inputs,
 * which stay contiguous and keep their bottom status. Outputs are named
 * past every manifest number in use (`knownTop` and `m/`), so they never overwrite a run one may list.
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
  const { ssts, droppedSeq } = await mergeSsts(
    blobs,
    plan.bottom,
    TARGET_RUN_BYTES,
    codecForLevel(plan.outputLevel),
  );
  const outputs: RunMeta[] = [];
  for (const [i, sst] of ssts.entries()) {
    const name = `c${top + 1}.${i}`;
    const path = levelRunPath(plan.outputLevel, name, sst.byteLength);
    await publishRun(fs, path, sst);
    outputs.push(runMeta(path, sst));
  }
  return { inputs: plan.inputs.map((r) => r.path), outputs, droppedSeq };
}

/**
 * Swap the step's inputs for its output in the committed generation, and
 * publish the result, which commits it. The inputs and the old manifests
 * stay on disk: tabs may still read them, so the host retires them (see
 * `EngineHost.reclaim`). Run under the ingest lock.
 */
export async function installStep(
  fs: AsyncFs,
  step: CompactionOutput,
  trust: (generation: number) => boolean = () => false,
): Promise<number> {
  const { meta, top } = await recoverGeneration(fs, trust, { underIngestLock: true });
  const live = new Set(meta.runs.map((r) => r.path));
  if (!step.inputs.every((p) => live.has(p))) {
    throw new Error("compaction inputs left the committed generation");
  }
  const runs = replaceRuns(meta.runs, step.inputs, step.outputs);
  const generation = top + 1;
  await publishGeneration(fs, {
    generation,
    runs,
    tombstoneSeq: Math.max(meta.tombstoneSeq, step.droppedSeq),
    through: meta.through,
    cut: meta.cut,
  });
  return generation;
}
