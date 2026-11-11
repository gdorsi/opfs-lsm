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
 *    recorded), the newest intact manifest numbered past `destroyedTop`, or
 *    the empty generation 0. The ones at or below it predate a destroy.
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
  return untilAdopted(wal, fs, async ({ meta, numbers, top }) => {
    const pick = await choose(fs, meta, numbers, trusted);
    if (!pick) return { generation: meta.generation!, top };
    // No seq any manifest on disk names is handed out again, so a manifest
    // that is not intact now never becomes intact with other writes.
    const floor = await highestThrough(fs, numbers, pick.through);
    const adopted = await wal.adopt(meta, pick.generation, pick.through, floor, top);
    return adopted ? { generation: pick.generation, top } : undefined;
  });
}

/**
 * Empty the database in one IndexedDB transaction, the commit point of
 * `dangerousDestroy` (design.md, "Destroy"): drop every WAL record and
 * record generation 0 with `head` and `ingestedThrough` one past every seq
 * the WAL or a manifest on disk names, and `destroyedTop` at the highest
 * manifest number in use. Recovery then adopts no manifest on disk, now or
 * after later flushes: rule 1 needs a `through` past the head, rule 2 keeps
 * the recorded generation, and rule 3 skips every number up to
 * `destroyedTop`. So the files are garbage whether or not they are removed
 * after. The commit is on disk before it resolves, so no power loss keeps
 * a remove that follows and loses it.
 */
export async function recordEmpty(wal: IdBWal, fs: AsyncFs): Promise<void> {
  await untilAdopted(wal, fs, async ({ meta, numbers, top }) => {
    const floor = await highestThrough(fs, numbers, meta.head);
    return (await wal.empty(meta, floor + 1, top)) || undefined;
  });
}

/** What `meta` and `m/` held when a writer read them, and the number new manifests go past. */
type Seen = { readonly meta: WalMeta; readonly numbers: readonly number[]; readonly top: number };

/**
 * Read `meta` and `m/`, then run `record`, which adopts against them.
 * Undefined from `record` means another tab or host changed `meta` first,
 * so read and run it again.
 */
async function untilAdopted<T>(
  wal: IdBWal,
  fs: AsyncFs,
  record: (seen: Seen) => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const [meta, numbers] = await Promise.all([wal.meta(), manifestNumbers(fs)]);
    const top = Math.max(numbers[0] ?? 0, meta.top, meta.generation ?? 0);
    const out = await record({ meta, numbers, top });
    if (out !== undefined) return out;
  }
  throw new CorruptDatabaseError("the WAL kept changing while it was read");
}

/** The highest `through` of the manifests `numbers`, and at least `from`. */
async function highestThrough(fs: AsyncFs, numbers: readonly number[], from: number): Promise<number> {
  let floor = from;
  for (const n of numbers) floor = Math.max(floor, (await readManifest(fs, n))?.through ?? 0);
  return floor;
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
    if (n <= meta.destroyedTop) break;
    const m = await probeManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) return m;
  }
  return GENERATION_ZERO;
}
