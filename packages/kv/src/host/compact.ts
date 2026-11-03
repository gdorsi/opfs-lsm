import type { AsyncFs } from "../opfs/async-fs.js";
import { mergeSsts, planL0Compaction } from "../store/engine.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishSst,
  reclaimRuns,
  type GenerationMeta,
} from "../store/generation.js";

export type CompactResult = {
  readonly compacted: boolean;
  readonly generation: number;
};

/**
 * If L0 count ≥ threshold, merge all L0 runs into one `sst/` file, publish a
 * new generation, and reclaim the replaced L0 files.
 */
export async function maybeCompact(fs: AsyncFs): Promise<CompactResult> {
  const meta = await loadLatestGeneration(fs);
  if (!meta) return { compacted: false, generation: 0 };

  const plan = await planL0Compaction(meta.runs);
  if (!plan) {
    return { compacted: false, generation: meta.generation };
  }

  const blobs: Uint8Array[] = [];
  for (const path of plan.inputs) {
    const buf = await fs.read(path, 0, 1 << 26);
    if (!buf) {
      throw new Error(`compaction missing input ${path}`);
    }
    blobs.push(buf);
  }

  const merged = await mergeSsts(blobs);
  const outPath = await publishSst(
    fs,
    `c${meta.generation + 1}-${plan.inputs.length}`,
    merged,
  );
  const newRuns = [outPath, ...plan.keep];
  const generation = meta.generation + 1;
  await publishGeneration(fs, generation, newRuns);
  await reclaimRuns(fs, plan.inputs, newRuns);

  return { compacted: true, generation };
}

export async function compactUntilQuiet(fs: AsyncFs): Promise<GenerationMeta | undefined> {
  let last = await loadLatestGeneration(fs);
  for (let i = 0; i < 8; i++) {
    const r = await maybeCompact(fs);
    if (!r.compacted) break;
    last = await loadLatestGeneration(fs);
  }
  return last;
}
