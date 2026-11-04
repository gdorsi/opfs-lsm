import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { mergeSsts } from "../store/engine.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishRun,
  reclaimRuns,
} from "../store/generation.js";
import {
  levelRunPath,
  planCompaction,
  replaceRuns,
} from "../store/levels.js";

export type CompactResult = {
  readonly compacted: boolean;
  readonly generation: number;
};

/**
 * Run one compaction step from `planCompaction`: merge its inputs into one
 * run at the output level, publish a new generation, record it in IDB, then
 * reclaim the inputs. Tabs read runs by the IDB generation, so the files go
 * only after it moves.
 */
export async function maybeCompact(
  fs: AsyncFs,
  wal: IdBWal,
): Promise<CompactResult> {
  const meta = await loadLatestGeneration(fs);
  if (!meta) return { compacted: false, generation: 0 };
  const plan = planCompaction(meta.runs);
  if (!plan) return { compacted: false, generation: meta.generation };

  const blobs: Uint8Array[] = [];
  for (const path of plan.inputs) {
    const buf = await fs.read(path, 0, 1 << 30);
    if (!buf) throw new Error(`compaction missing input ${path}`);
    blobs.push(buf);
  }
  const { sst: merged, droppedSeq } = await mergeSsts(blobs, plan.bottom);
  const generation = meta.generation + 1;
  const output =
    merged.byteLength > 0
      ? await publishRun(
          fs,
          levelRunPath(plan.outputLevel, `c${generation}`, merged.byteLength),
          merged,
        )
      : undefined;
  const runs = replaceRuns(meta.runs, plan.inputs, output);
  await publishGeneration(fs, {
    generation,
    runs,
    tombstoneSeq: Math.max(meta.tombstoneSeq, droppedSeq),
  });
  await wal.raiseGeneration(generation);
  await reclaimRuns(fs, plan.inputs, runs);
  return { compacted: true, generation };
}
