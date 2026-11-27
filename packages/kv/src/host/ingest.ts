import { flushBytes } from "../check.js";
import type { IdBWal } from "../idb/wal.js";
import { advanceIngested, readUningested } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { nextGeneration, type Generation, type Seq } from "../seq.js";
import { reconcile, type Trusted } from "../recover.js";
import { publishGeneration, publishL0 } from "./publish.js";
import { loadRecorded } from "../store/generation.js";
import { foldRecords } from "../store/fold.js";
import { retireMarks } from "../store/marks.js";

export type IngestResult = {
  readonly generation: Generation;
  readonly ingestedThrough: Seq;
  /** `flushBytes` of the WAL records this call folded into the new L0. */
  readonly foldedBytes: number;
};

/** What bounds one `ingestChunk`. */
type ChunkLimits = {
  /** `flushBytes` of WAL records folded into the run. At least one record is taken. */
  readonly maxBytes: number;
  /** The L0 run count at which no more runs are published. */
  readonly l0Stop: number;
};

/** What `ingestChunk` did. */
export type Chunk = IngestResult & {
  /**
   * "empty" when no record up to `head` was waiting, and "stopped" when
   * some were but L0 holds `l0Stop` runs. Neither published anything.
   */
  readonly kind: "folded" | "empty" | "stopped";
};

/**
 * Fold the oldest uningested WAL records into one L0, publish generation, and
 * advance ingestedThrough. It takes at most `maxBytes` of op bytes, and at
 * least one record, so a backlog takes several calls and each run stays
 * small. Compaction runs separately. `head` is the WAL head the fold read
 * when it started: it folds nothing once every seq up to it is ingested. A
 * chunk that starts at or below `head` may take records past it. It folds
 * nothing when L0 is full, so compaction can catch up. Removes no file: the
 * host removes old manifests once no tab is loading a generation
 * (`HostedDb.fold`).
 *
 * Builds on the recorded generation, never on a newer manifest file: one
 * that IndexedDB has not recorded is left by a crash, and its seqs are
 * either still in the WAL or were adopted by `reconcile`. `trusted` names a
 * generation the caller knows is intact (see `reconcile`).
 */
export async function ingestChunk(
  wal: IdBWal,
  fs: AsyncFs,
  head: Seq,
  trusted: Trusted,
  limits: ChunkLimits,
): Promise<Chunk> {
  const base = await reconcile(wal, fs, trusted);
  const { records, through: ingested } = await readUningested(wal, limits.maxBytes, head);
  if (records.length === 0) {
    return { kind: "empty", generation: base.generation, ingestedThrough: ingested, foldedBytes: 0 };
  }
  const prev = await loadRecorded(fs, base.generation);
  if (prev.runs.filter((r) => r.level === 0).length >= limits.l0Stop) {
    return { kind: "stopped", generation: base.generation, ingestedThrough: ingested, foldedBytes: 0 };
  }
  const folded = foldRecords(records);
  const first = records[0]!.seq;
  const last = records[records.length - 1]!.seq;

  const generation = nextGeneration(base.top);
  // A chunk whose range deletes left no entry publishes no run.
  const runs =
    folded.entries.length > 0 ? [await publishL0(fs, `${first}-${last}`, folded.entries, last), ...prev.runs] : prev.runs;
  const manifest = await publishGeneration(fs, {
    generation,
    runs,
    through: last,
    marks: retireMarks([...prev.marks, ...folded.marks], runs),
  });
  let foldedBytes = 0;
  for (const r of records) foldedBytes += flushBytes(r.ops);
  await advanceIngested(wal, { through: last, generation, manifest });
  return { kind: "folded", generation, ingestedThrough: last, foldedBytes };
}
