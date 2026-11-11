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

/** A generation whose manifest `reconcile` need not check, "recorded" for whichever is recorded, or undefined to check. */
export type Trusted = number | "recorded" | undefined;

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
 * 2. Otherwise the recorded manifest, when it is intact. `trusted` skips
 *    the check for a generation the caller has loaded or published itself,
 *    or for whatever is recorded when it is "recorded".
 * 3. Otherwise, when the recorded manifest is missing (or none is
 *    recorded), the newest intact manifest, or the empty generation 0.
 *
 * Corruption is not a power loss, and recovery never turns it into lost
 * data: it throws `CorruptDatabaseError` and writes nothing, so no WAL
 * record is dropped and no sweep runs against a stand-in.
 *
 * - The recorded manifest is there but does not decode: throw.
 * - It decodes but lists a run that is gone: only an intact manifest whose
 *   `through` reaches `ingestedThrough` may replace it, since it and the
 *   WAL still hold every seq. Otherwise throw.
 * - Rule 3 meets a manifest that does not decode before an intact one:
 *   throw, since it may be the newest state.
 *
 * Writes only for 1, 3 and the replacement, so a healthy database pays one
 * `meta` read and one listing of `m/`. In a running database none holds: a
 * manifest's `through` is at most the head when it is written, `head` never
 * moves down, and reclaim never removes the recorded manifest or its runs.
 */
export async function reconcile(
  wal: IdBWal,
  fs: AsyncFs,
  trusted: Trusted,
): Promise<Reconciled> {
  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const [meta, numbers] = await Promise.all([wal.meta(), manifestNumbers(fs)]);
    const top = Math.max(numbers[0] ?? 0, meta.top, meta.generation ?? 0);
    const pick = await choose(fs, meta, numbers, trusted);
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

/**
 * Empty the database in one IndexedDB transaction, the commit point of
 * `dangerousDestroy` (design.md, "Destroy"): drop every WAL record and
 * record generation 0 with `head` and `ingestedThrough` one past every seq
 * the WAL or a manifest on disk names. Recovery then adopts no manifest
 * on disk: rule 1 needs a `through` past the head, and rule 2 keeps the
 * recorded generation 0. So the files are garbage whether or not they are
 * removed after, and new manifests number past every one of them.
 */
export async function recordEmpty(wal: IdBWal, fs: AsyncFs): Promise<void> {
  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const meta = await wal.meta();
    const numbers = await manifestNumbers(fs);
    const top = Math.max(numbers[0] ?? 0, meta.top, meta.generation ?? 0);
    let floor = meta.head;
    for (const n of numbers) floor = Math.max(floor, (await readManifest(fs, n))?.through ?? 0);
    if (await wal.adopt(meta, 0, 0, floor + 1, top)) return;
  }
  throw new CorruptDatabaseError("the WAL kept changing while destroy read it");
}

/** The manifest to record instead of the recorded one, or undefined to keep it. */
async function choose(
  fs: AsyncFs,
  meta: WalMeta,
  numbers: readonly number[],
  trusted: Trusted,
): Promise<GenerationMeta | undefined> {
  const recorded = meta.generation;
  for (const n of numbers) {
    if (recorded !== undefined && n <= recorded) break;
    const m = await readManifest(fs, n);
    if (m && m.through > meta.head && (await isIntact(fs, m))) return m;
  }
  if (recorded !== undefined) {
    if (trusted === "recorded" || trusted === recorded) return undefined;
    const m = await probeManifest(fs, recorded);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${recorded} does not decode`);
    if (m !== "missing") {
      if (await isIntact(fs, m)) return undefined;
      for (const n of numbers) {
        const other = await readManifest(fs, n);
        if (other && other.through >= meta.ingestedThrough && (await isIntact(fs, other))) return other;
      }
      throw new CorruptDatabaseError(`manifest ${recorded} lists a run that is gone`);
    }
  }
  for (const n of numbers) {
    const m = await probeManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) return m;
  }
  return GENERATION_ZERO;
}
