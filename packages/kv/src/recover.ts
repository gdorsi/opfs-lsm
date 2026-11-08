import { CorruptDatabaseError } from "./errors.js";
import type { IdBWal, WalMeta } from "./idb/wal.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import {
  GENERATION_ZERO,
  isIntact,
  manifestNumbers,
  probeManifest,
  readManifest,
  type GenerationMeta,
} from "./store/generation.js";

export type Reconciled = {
  /** The recorded generation. Its manifest and the WAL hold one log prefix. */
  readonly generation: number;
  /**
   * The highest manifest number in use: in `m/`, recorded, or seen by an
   * earlier recovery (`topGeneration`). A new manifest or compaction output
   * numbers past it, so no number names two different manifests, and no
   * output overwrites a run a manifest on disk may list.
   */
  readonly top: number;
};

/** Attempts when another tab or host changes `meta` under a reconcile. */
const RECONCILE_TRIES = 8;

/**
 * Make IndexedDB record a manifest that pairs with its WAL (design.md,
 * "Recovery"). After a power loss, IndexedDB and OPFS each keep a prefix of
 * their own writes, with no order between them, so the recorded manifest
 * can be gone, or OPFS can hold seqs the WAL lost. Every intact manifest is
 * the fold of the log through its `through`, so recovery picks one and
 * pairs it with the WAL records above it:
 *
 * 1. The newest intact manifest past the recorded one whose `through` is
 *    past the WAL head: OPFS kept writes IndexedDB lost. It is a longer
 *    prefix, and recording it moves `head` past its seqs before any of them
 *    is handed out again.
 * 2. Otherwise the recorded manifest, when it is intact. `trust` skips the
 *    check for a generation the caller has loaded or published itself.
 * 3. Otherwise the newest intact manifest, or the empty generation 0.
 *
 * Corruption is not a power loss, and recovery never turns it into lost
 * data. A recorded manifest that is there but does not decode, or one that
 * does not decode before rule 3 reaches an intact one, throws
 * `CorruptDatabaseError` and writes nothing, so no WAL record is dropped
 * and no sweep runs against a stand-in.
 *
 * Writes only for 1 and 3, so a healthy database pays one `meta` read and
 * one listing of `m/`. In a running database neither 1 nor 3 holds: a
 * manifest's `through` is at most the head when it is written, `head` never
 * moves down, and reclaim never removes the recorded manifest or its runs.
 */
export async function reconcile(
  wal: IdBWal,
  fs: AsyncFs,
  trust: (generation: number) => boolean,
): Promise<Reconciled> {
  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const meta = await wal.meta();
    const numbers = await manifestNumbers(fs);
    const top = Math.max(numbers[0] ?? 0, meta.top, meta.generation ?? 0);
    const pick = await choose(fs, meta, numbers, trust);
    if (!pick) return { generation: meta.generation!, top };
    // No seq any manifest on disk names is handed out again, so a manifest
    // that is not intact now never becomes intact with other writes.
    let floor = pick.through;
    for (const n of numbers) floor = Math.max(floor, (await readManifest(fs, n))?.through ?? 0);
    if (await wal.adopt(meta, pick.generation, pick.through, floor, top)) {
      return { generation: pick.generation, top };
    }
  }
  throw new CorruptDatabaseError("the WAL kept changing while recovery read it");
}

/** The manifest to record instead of the recorded one, or undefined to keep it. */
async function choose(
  fs: AsyncFs,
  meta: WalMeta,
  numbers: readonly number[],
  trust: (generation: number) => boolean,
): Promise<GenerationMeta | undefined> {
  const recorded = meta.generation;
  for (const n of numbers) {
    if (recorded !== undefined && n <= recorded) break;
    const m = await readManifest(fs, n);
    if (m && m.through > meta.head && (await isIntact(fs, m))) return m;
  }
  if (recorded !== undefined) {
    if (trust(recorded)) return undefined;
    const m = await probeManifest(fs, recorded);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${recorded} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) return undefined;
  }
  for (const n of numbers) {
    const m = await probeManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) return m;
  }
  return GENERATION_ZERO;
}
