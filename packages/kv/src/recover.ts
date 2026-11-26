import { CorruptDatabaseError } from "./errors.js";
import { forgetDestroyed, readDestroyed, type DestroyedFloor } from "./idb/destroyed.js";
import type { IdBWal, WalMeta } from "./idb/wal.js";
import { adopt, emptyWal, recordNew } from "./idb/wal.js";
import type { ReadFs } from "./opfs/async-fs.js";
import { asGeneration, asSeq, GENERATION_NONE, nextSeq, SEQ_ZERO, type Generation, type Seq } from "./seq.js";
import {
  GENERATION_ZERO,
  isIntact,
  manifestNumbers,
  readManifest,
  type GenerationMeta,
} from "./store/generation.js";

export type Reconciled = {
  /** The recorded generation. Its manifest and the WAL hold one log prefix. */
  readonly generation: Generation;
  /**
   * The highest manifest number in use: in `m/`, recorded, or seen by an
   * earlier recovery (`topGeneration`). A new manifest or compaction output
   * numbers past it, so no number names two different manifests, and no
   * output overwrites a run a manifest on disk may list.
   */
  readonly top: Generation;
  /** True when nothing was written: a tail read before the call is still a tail. */
  readonly kept: boolean;
};

/** Attempts when another tab or host changes `meta` under a reconcile. */
const RECONCILE_TRIES = 8;

/** A generation whose manifest `reconcile` need not check, or undefined to check. */
export type Trusted = Generation | undefined;

/**
 * Make IndexedDB record a manifest that pairs with its WAL (design.md,
 * "Recovery"). After a power loss, IndexedDB and OPFS each keep a prefix of
 * their own writes, with no order between them, so the recorded manifest
 * can be gone, or OPFS can hold seqs the WAL lost. Every intact manifest is
 * the fold of the log through its `through`, so recovery picks one and
 * pairs it with the WAL records above it:
 *
 * 0. The WAL database records no generation, so it was just created, and
 *    `opfs-lsm-destroyed` has a row for the name: `destroyDb` removed a
 *    database of this name, and a power loss may have kept some of its
 *    files. Record the empty generation 0 past the row (strict), then
 *    forget the row. No manifest from before the removal is adopted, now
 *    or later. A manifest numbered past the row's `top` means a database
 *    born after the removal wrote it, and the browser threw away its WAL
 *    database: record generation 0 at the row's own figures instead, forget
 *    the row, and run rules 1 to 3, which recover the newer database and
 *    skip every manifest at or below the row. Without a row, rules 1 to 3
 *    run, so a WAL database the browser threw away still recovers the
 *    newest intact manifest.
 * 1. The newest intact manifest past the recorded one whose `through` is
 *    past the WAL head: OPFS kept writes IndexedDB lost. It is a longer
 *    prefix, and recording it moves `head` past its seqs before any of them
 *    is handed out again.
 * 2. Otherwise the recorded manifest, when it is intact. `trusted` skips
 *    the check for a generation the caller has loaded or published itself.
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
  fs: ReadFs,
  trusted: Trusted,
): Promise<Reconciled> {
  return untilAdopted(wal, fs, async ({ meta, numbers, top }) => {
    if (meta.generation === undefined) {
      const known = await readDestroyed(wal.dbName);
      if (known) {
        // A manifest numbered past the row was written by a database born after it.
        const outgrown = (numbers[0] ?? GENERATION_NONE) > known.top;
        const born = outgrown ? known : atLeast(known, { head: nextSeq(await highestThrough(fs, numbers, meta.head)), top });
        if ((await emptyWal(wal, { expect: meta, ...born })) === undefined) return undefined;
        // Only after the strict birth: losing this delete leaves a row that is ignored.
        await forgetDestroyed(wal.dbName, known);
        // Read `meta` again: it records generation 0 now, and rule 1 adopts the newer database's manifest.
        if (outgrown) return undefined;
        return { generation: GENERATION_NONE, top: born.top, kept: false };
      }
    }
    const pick = await choose(fs, meta, numbers, trusted);
    if (!pick) return { generation: meta.generation!, top, kept: true };
    // No seq any manifest on disk names is handed out again, so a manifest
    // that is not intact now never becomes intact with other writes.
    const floor = await highestThrough(fs, numbers, pick.through);
    const adopted = await adopt(wal, { expect: meta, generation: pick.generation, through: pick.through, floor, top });
    return adopted ? { generation: pick.generation, top, kept: false } : undefined;
  });
}

/**
 * `reconcile` for a tab's open, which trusts the recorded manifest: the load
 * that follows opens its runs. True when that manifest stands and nothing was
 * written. A tab writes one case itself, generation 0 for a database with
 * nothing stored, so a first open waits for no host. Every other write is
 * the host's: `repair` has it run `reconcile` in its exclusive section.
 */
export async function reconcileOpen(wal: IdBWal, fs: ReadFs, repair: () => Promise<void>): Promise<boolean> {
  const [meta, numbers] = await Promise.all([wal.meta(), manifestNumbers(fs)]);
  if (meta.generation !== undefined) {
    if (!(await longerPrefix(fs, meta, numbers))) return true;
  } else if (numbers.length === 0 && meta.head === SEQ_ZERO && !(await readDestroyed(wal.dbName))) {
    if (await recordNew(wal, meta)) return false;
  }
  await repair();
  return false;
}

/**
 * Empty the database in one IndexedDB transaction, the commit point of both
 * destroys (design.md, "Destroy"): drop every WAL record and record
 * generation 0 with `head` and `ingestedThrough` one past every seq the
 * WAL, a manifest on disk or `known` names, and `destroyedTop` at the
 * highest manifest number in use, and at least `known.top`. Recovery then
 * adopts no manifest on disk, now or after later flushes: rule 1 needs a
 * `through` past the head, rule 2 keeps the recorded generation, and rule 3
 * skips every number up to `destroyedTop`. So the files are garbage whether
 * or not they are removed after. The commit is on disk before it resolves,
 * so no power loss keeps a remove that follows and loses it. `fs` is
 * undefined when the database has no folder. Returns what it recorded.
 */
export async function recordEmpty(
  wal: IdBWal,
  fs: ReadFs | undefined,
  known: DestroyedFloor | undefined,
): Promise<DestroyedFloor> {
  return untilAdopted(wal, fs, async ({ meta, numbers, top }) => {
    const floor = atLeast(known, { head: nextSeq(await highestThrough(fs, numbers, meta.head)), top });
    const head = await emptyWal(wal, { expect: meta, ...floor, pastAppends: true });
    return head === undefined ? undefined : { head, top: floor.top };
  });
}

/**
 * The floor of a folder whose WAL database is gone: `head` past the highest
 * `through` of the manifests on disk, `top` at the highest number, each at
 * least `known`'s. Undefined when no manifest is on disk: then no file can
 * be adopted.
 */
export async function floorOfFiles(fs: ReadFs, known: DestroyedFloor | undefined): Promise<DestroyedFloor | undefined> {
  const numbers = await manifestNumbers(fs);
  if (numbers.length === 0) return undefined;
  return atLeast(known, { head: nextSeq(await highestThrough(fs, numbers, SEQ_ZERO)), top: numbers[0]! });
}

/** `floor`, raised to `known`'s figures. */
function atLeast(known: DestroyedFloor | undefined, floor: DestroyedFloor): DestroyedFloor {
  if (!known) return floor;
  return { head: asSeq(Math.max(floor.head, known.head)), top: asGeneration(Math.max(floor.top, known.top)) };
}

/** What `meta` and `m/` held when a writer read them, and the number new manifests go past. */
type Seen = { readonly meta: WalMeta; readonly numbers: readonly Generation[]; readonly top: Generation };

/**
 * Read `meta` and `m/`, then run `record`, which adopts against them.
 * Undefined from `record` means another tab or host changed `meta` first,
 * so read and run it again.
 */
async function untilAdopted<T>(
  wal: IdBWal,
  fs: ReadFs | undefined,
  record: (seen: Seen) => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const [meta, numbers] = await Promise.all([wal.meta(), fs ? manifestNumbers(fs) : []]);
    const top = asGeneration(Math.max(numbers[0] ?? GENERATION_NONE, meta.top, meta.generation ?? GENERATION_NONE));
    const out = await record({ meta, numbers, top });
    if (out !== undefined) return out;
  }
  throw new CorruptDatabaseError("the WAL kept changing while it was read");
}

/** The highest `through` of the manifests `numbers`, and at least `from`. */
async function highestThrough(fs: ReadFs | undefined, numbers: readonly Generation[], from: Seq): Promise<Seq> {
  let floor = from;
  if (!fs) return floor;
  for (const n of numbers) {
    const m = await readManifest(fs, n);
    if (typeof m === "object" && m.through > floor) floor = m.through;
  }
  return floor;
}

/** Rule 1: the newest intact manifest past the recorded one whose `through` is past the WAL head. */
async function longerPrefix(fs: ReadFs, meta: WalMeta, numbers: readonly Generation[]): Promise<GenerationMeta | undefined> {
  for (const n of numbers) {
    if (meta.generation !== undefined && n <= meta.generation) break;
    const m = await readManifest(fs, n);
    if (typeof m === "object" && m.through > meta.head && (await isIntact(fs, m))) return m;
  }
  return undefined;
}

/** The manifest to record instead of the recorded one, or undefined to keep it. */
async function choose(
  fs: ReadFs,
  meta: WalMeta,
  numbers: readonly Generation[],
  trusted: Trusted,
): Promise<GenerationMeta | undefined> {
  const recorded = meta.generation;
  const longer = await longerPrefix(fs, meta, numbers);
  if (longer) return longer;
  if (recorded !== undefined) {
    if (trusted === recorded) return undefined;
    const m = await readManifest(fs, recorded);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${recorded} does not decode`);
    if (m !== "missing") {
      if (await isIntact(fs, m)) return undefined;
      for (const n of numbers) {
        const other = await readManifest(fs, n);
        if (typeof other === "object" && other.through >= meta.ingestedThrough && (await isIntact(fs, other))) return other;
      }
      throw new CorruptDatabaseError(`manifest ${recorded} lists a run that is gone`);
    }
  }
  for (const n of numbers) {
    if (n <= meta.destroyedTop) break;
    const m = await readManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) return m;
  }
  return GENERATION_ZERO;
}
