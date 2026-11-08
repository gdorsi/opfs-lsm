import { opsBytes } from "../check.js";
import { CorruptDatabaseError } from "../errors.js";
import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { reconcile } from "../recover.js";
import {
  loadGeneration,
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
 *
 * Builds on the recorded generation, never on a newer manifest file: one
 * that IndexedDB has not recorded is left by a crash, and its seqs are
 * either still in the WAL or were adopted by `reconcile`. `trust` names a
 * generation the caller knows is intact (see `reconcile`).
 */
export async function ingestAll(
  wal: IdBWal,
  fs: AsyncFs,
  through = Number.POSITIVE_INFINITY,
  trust: (generation: number) => boolean = () => false,
): Promise<IngestResult> {
  const base = await reconcile(wal, fs, trust);
  const records =
    (await wal.getIngestedThrough()) >= through ? [] : await wal.listUningested();
  let generation: number;
  let ingestedThrough: number;
  let foldedBytes = 0;

  if (records.length === 0) {
    generation = base.generation;
    ingestedThrough = await wal.getIngestedThrough();
  } else {
    const entries = foldRecords(records);
    const first = records[0]!.seq;
    const last = records[records.length - 1]!.seq;

    const prev = await loadGeneration(fs, base.generation);
    if (!prev) throw new CorruptDatabaseError(`manifest ${base.generation} is gone`);
    generation = base.top + 1;
    const l0 = await publishL0(fs, `${first}-${last}`, entries);
    await publishGeneration(fs, {
      generation,
      runs: [l0, ...prev.runs],
      tombstoneSeq: prev.tombstoneSeq,
      through: last,
    });
    for (const r of records) foldedBytes += opsBytes(r.ops);
    await wal.advanceIngested(last, generation, foldedBytes);
    ingestedThrough = last;
  }

  await reclaimManifests(fs, (await wal.recordedGeneration()) ?? 0);
  return { generation, ingestedThrough, foldedBytes };
}
