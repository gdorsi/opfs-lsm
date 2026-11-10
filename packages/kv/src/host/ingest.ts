import { opsBytes } from "../check.js";
import { CorruptDatabaseError } from "../errors.js";
import type { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { reconcile } from "../recover.js";
import {
  loadGeneration,
  publishGeneration,
  publishL0,
} from "../store/generation.js";
import { foldRecords } from "../store/fold.js";
import { levelOf } from "../store/levels.js";

export type IngestResult = {
  readonly generation: number;
  readonly ingestedThrough: number;
  /** Op bytes of the WAL records this call folded into the new L0. */
  readonly foldedBytes: number;
};

/** What bounds one `ingestChunk`. */
export type ChunkLimits = {
  /** Op bytes of WAL records folded into the run. At least one record is taken. */
  readonly maxBytes: number;
  /** The L0 run count at which no more runs are published. */
  readonly l0Stop: number;
};

/** What `ingestChunk` did. */
export type Chunk = IngestResult & {
  /**
   * "empty" when no record through `through` was waiting, and "stopped" when
   * some were but L0 holds `l0Stop` runs. Neither published anything.
   */
  readonly kind: "folded" | "empty" | "stopped";
};

/**
 * Fold the oldest uningested WAL records into one L0, publish generation, and
 * advance ingestedThrough. It takes at most `maxBytes` of op bytes, and at
 * least one record, so a backlog takes several calls and each run stays
 * small. Compaction runs separately. Folds nothing when every seq through
 * `through` is already ingested, so tabs that ask for the same flush get one
 * L0, and when L0 is full, so compaction can catch up. Removes no file: the
 * host removes old manifests once no tab is loading a generation
 * (`EngineHost.fold`).
 *
 * Builds on the recorded generation, never on a newer manifest file: one
 * that IndexedDB has not recorded is left by a crash, and its seqs are
 * either still in the WAL or were adopted by `reconcile`. `trust` names a
 * generation the caller knows is intact (see `reconcile`).
 */
export async function ingestChunk(
  wal: IdBWal,
  fs: AsyncFs,
  through: number,
  trust: (generation: number) => boolean,
  limits: ChunkLimits,
): Promise<Chunk> {
  const base = await reconcile(wal, fs, trust);
  const ingested = await wal.getIngestedThrough();
  const records = ingested >= through ? [] : await wal.listUningested({ maxBytes: limits.maxBytes });
  let kind: Chunk["kind"];
  let generation: number;
  let ingestedThrough: number;
  let foldedBytes = 0;

  if (records.length === 0) {
    kind = "empty";
    generation = base.generation;
    ingestedThrough = ingested;
  } else {
    const prev = await loadGeneration(fs, base.generation);
    if (!prev) throw new CorruptDatabaseError(`manifest ${base.generation} is gone`);
    if (prev.runs.filter((r) => levelOf(r.path) === 0).length >= limits.l0Stop) {
      return { kind: "stopped", generation: base.generation, ingestedThrough: ingested, foldedBytes: 0 };
    }
    kind = "folded";
    const entries = foldRecords(records);
    const first = records[0]!.seq;
    const last = records[records.length - 1]!.seq;

    generation = base.top + 1;
    const l0 = await publishL0(fs, `${first}-${last}`, entries);
    await publishGeneration(fs, {
      generation,
      runs: [l0, ...prev.runs],
      tombstoneSeq: prev.tombstoneSeq,
      through: last,
    });
    for (const r of records) foldedBytes += opsBytes(r.ops);
    await wal.advanceIngested(last, generation);
    ingestedThrough = last;
  }

  return { kind, generation, ingestedThrough, foldedBytes };
}
