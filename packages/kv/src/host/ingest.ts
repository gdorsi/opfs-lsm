import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishL0,
  reclaimManifests,
} from "../store/generation.js";
import { foldRecords } from "../store/fold.js";
import { maybeCompact } from "./compact.js";

/** One L0 merge plus a cascade through every level a real database reaches. */
const MAX_COMPACTION_STEPS = 8;

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
  const records = await wal.listUningested();
  let generation: number;
  let ingestedThrough: number;

  if (records.length === 0) {
    const cur = await loadLatestGeneration(fs);
    generation = cur?.generation ?? 0;
    ingestedThrough = await wal.getIngestedThrough();
  } else {
    const entries = foldRecords(records);
    const first = records[0]!.seq;
    const last = records[records.length - 1]!.seq;

    const prev = await loadLatestGeneration(fs);
    generation = (prev?.generation ?? 0) + 1;
    const l0Path = await publishL0(fs, `${first}-${last}`, entries);
    const runs = [l0Path, ...(prev?.runs ?? [])];
    await publishGeneration(fs, generation, runs);
    await wal.advanceIngested(last, generation);
    ingestedThrough = last;
  }

  let compacted = false;
  for (let step = 0; step < MAX_COMPACTION_STEPS; step++) {
    const compact = await maybeCompact(fs, wal);
    if (!compact.compacted) break;
    compacted = true;
    generation = compact.generation;
  }
  await reclaimManifests(fs, (await wal.recordedGeneration()) ?? 0);

  return { generation, ingestedThrough, compacted };
}
