import { opsBytes } from "../check.js";
import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import {
  loadLatestGeneration,
  publishGeneration,
  publishL0,
  reclaimManifests,
} from "../store/generation.js";
import { foldRecords } from "../store/fold.js";

export type IngestResult = {
  readonly generation: number;
  readonly ingestedThrough: number;
  /** Op bytes of the WAL records this call folded into the new L0. */
  readonly foldedBytes: number;
};

/**
 * Fold the shared uningested WAL into one L0, publish generation, and
 * advance ingestedThrough. Compaction runs separately. Folds nothing when every seq
 * through `through` is already ingested, so tabs that ask for the same
 * flush get one L0.
 */
export async function ingestAll(
  wal: IdBWal,
  fs: AsyncFs,
  through = Number.POSITIVE_INFINITY,
): Promise<IngestResult> {
  const records =
    (await wal.getIngestedThrough()) >= through ? [] : await wal.listUningested();
  let generation: number;
  let ingestedThrough: number;
  let foldedBytes = 0;

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
    const l0 = await publishL0(fs, `${first}-${last}`, entries);
    await publishGeneration(fs, {
      generation,
      runs: [l0, ...(prev?.runs ?? [])],
      tombstoneSeq: prev?.tombstoneSeq ?? 0,
    });
    await wal.advanceIngested(last, generation);
    ingestedThrough = last;
    for (const r of records) foldedBytes += opsBytes(r.ops);
  }

  await reclaimManifests(fs, (await wal.recordedGeneration()) ?? 0);
  return { generation, ingestedThrough, foldedBytes };
}
