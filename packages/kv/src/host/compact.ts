import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { mergeSsts } from "../store/engine.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishRun,
  reclaimManifests,
  reclaimRuns,
  runMeta,
  type RunMeta,
} from "../store/generation.js";
import {
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
 * Plan one step on the latest generation, merge its inputs, and write the
 * output run. Needs no ingest lock: a flush meanwhile only adds L0 runs in
 * front of the inputs, which stay contiguous and keep their bottom status.
 */
export async function mergeNextStep(
  fs: AsyncFs,
): Promise<CompactionOutput | undefined> {
  const meta = await loadLatestGeneration(fs);
  if (!meta) return undefined;
  const plan = planCompaction(meta.runs);
  if (!plan) return undefined;

  const blobs: Uint8Array[] = [];
  for (const { path } of plan.inputs) {
    const buf = await fs.read(path, 0, Number.POSITIVE_INFINITY);
    if (!buf) throw new Error(`compaction missing input ${path}`);
    blobs.push(buf);
  }
  const { ssts, droppedSeq } = await mergeSsts(blobs, plan.bottom, TARGET_RUN_BYTES);
  const outputs: RunMeta[] = [];
  for (const [i, sst] of ssts.entries()) {
    const name = `c${meta.generation + 1}.${i}`;
    const path = levelRunPath(plan.outputLevel, name, sst.byteLength);
    await publishRun(fs, path, sst);
    outputs.push(runMeta(path, sst));
  }
  return { inputs: plan.inputs.map((r) => r.path), outputs, droppedSeq };
}

/**
 * Swap the step's inputs for its output in the latest generation, record
 * the generation in IDB, then reclaim the inputs. Tabs read runs by the IDB
 * generation, so the files go only after it moves. Run under the ingest lock.
 */
export async function installStep(
  fs: AsyncFs,
  wal: IdBWal,
  step: CompactionOutput,
): Promise<number> {
  const meta = await loadLatestGeneration(fs);
  const live = new Set(meta?.runs.map((r) => r.path));
  if (!meta || !step.inputs.every((p) => live.has(p))) {
    throw new Error("compaction inputs left the latest generation");
  }
  const runs = replaceRuns(meta.runs, step.inputs, step.outputs);
  const generation = meta.generation + 1;
  await publishGeneration(fs, {
    generation,
    runs,
    tombstoneSeq: Math.max(meta.tombstoneSeq, step.droppedSeq),
  });
  await wal.raiseGeneration(generation);
  await reclaimRuns(fs, step.inputs, runs.map((r) => r.path));
  await reclaimManifests(fs, generation);
  return generation;
}
