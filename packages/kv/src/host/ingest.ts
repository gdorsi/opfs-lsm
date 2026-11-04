import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishL0,
  reclaimManifests,
} from "../store/generation.js";
import { maybeCompact } from "./compact.js";

export type IngestResult = {
  readonly generation: number;
  readonly ingestedThrough: number;
  readonly compacted: boolean;
};

/**
 * Fold the shared uningested WAL into one L0, publish generation, advance
 * ingestedThrough, then maybe compact L0→sst.
 */
export async function ingestAll(
  wal: IdBWal,
  fs: AsyncFs,
): Promise<IngestResult> {
  const tail = await wal.listUningested();
  let generation: number;
  let ingestedThrough: number;

  if (!tail) {
    const cur = await loadLatestGeneration(fs);
    generation = cur?.generation ?? 0;
    ingestedThrough = await wal.getIngestedThrough();
  } else {
    const { first, last, entries } = tail;

    const prev = await loadLatestGeneration(fs);
    generation = (prev?.generation ?? 0) + 1;
    const l0Path = await publishL0(fs, `${first}-${last}`, entries);
    const runs = [l0Path, ...(prev?.runs ?? [])];
    await publishGeneration(fs, generation, runs);
    await wal.advanceIngested(last, generation);
    ingestedThrough = last;
  }

  const compact = await maybeCompact(fs, wal);
  if (compact.compacted) {
    generation = compact.generation;
  }
  await reclaimManifests(fs, (await wal.recordedGeneration()) ?? 0);

  return { generation, ingestedThrough, compacted: compact.compacted };
}
