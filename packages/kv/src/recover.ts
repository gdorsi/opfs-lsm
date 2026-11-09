import { CorruptDatabaseError } from "./errors.js";
import { parseSegment } from "./log/frame.js";
import { listSegments, listTabs } from "./log/reader.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import {
  GENERATION_ZERO,
  isIntact,
  listRuns,
  manifestNumbers,
  probeManifest,
  type GenerationMeta,
} from "./store/generation.js";

export type Recovered = {
  /** The committed generation: the newest manifest whose runs are all on disk. */
  readonly meta: GenerationMeta;
  /**
   * The highest manifest number in `m/`. A new manifest or compaction
   * output numbers past it, so no number names two different manifests,
   * and no output overwrites a run a manifest on disk may list.
   */
  readonly top: number;
};

/**
 * The committed generation (design.md, "Recovery"). Publishing a manifest
 * commits an ingest or a compaction step, and every manifest is the fold of
 * the logs through its `cut`, so the newest intact one wins.
 *
 * A power loss keeps a prefix of each file's writes with no order between
 * files, so the newest manifest may be gone, empty, or list a run that
 * never reached the disk. Then an older one stands in, but only
 * when the logs still hold every record above its cut: reclaim removes a
 * segment once a manifest covers it. Otherwise records would be missing
 * from the middle of the order, so this throws rather than open a state
 * that never existed.
 *
 * Corruption is not a power loss: a manifest that is there and does not
 * decode throws `CorruptDatabaseError`. `trust` skips the run check for a
 * generation the caller loaded or published itself.
 */
export async function recoverGeneration(
  fs: AsyncFs,
  trust: (generation: number) => boolean = () => false,
  opts: { readonly underIngestLock?: boolean } = {},
): Promise<Recovered> {
  for (;;) {
    const got = await recoverOnce(fs, trust, opts.underIngestLock === true);
    if (got) return got;
  }
}

/** Undefined when the manifests changed under the scan (a reclaim removed them after a newer one): scan again. */
async function recoverOnce(
  fs: AsyncFs,
  trust: (generation: number) => boolean,
  underIngestLock: boolean,
): Promise<Recovered | undefined> {
  const numbers = await manifestNumbers(fs);
  const top = numbers[0] ?? 0;
  const changed = async () => {
    const again = await manifestNumbers(fs);
    return again.length !== numbers.length || again.some((n, i) => n !== numbers[i]);
  };
  // The newest manifest skipped: empty, or listing a run that is gone.
  let skipped: string | undefined;
  for (const n of numbers) {
    const m = await probeManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (trust(n) || (await isIntact(fs, m)))) {
      if (skipped && !(await logsCover(fs, m.cut))) {
        if (await changed()) return undefined;
        throw new CorruptDatabaseError(`${skipped}, and the logs no longer hold what it covered`);
      }
      return { meta: m, top };
    }
    skipped ??= m === "missing" ? `manifest ${n} is empty` : `manifest ${n} lists a run that is gone`;
  }
  if (await changed()) return undefined;
  if (skipped && !(await logsCover(fs, 0))) throw new CorruptDatabaseError(skipped);
  // No manifest: a new database, or one whose first ingest stopped before
  // its manifest. Under the ingest lock nothing publishes meanwhile, so
  // anything else on disk means a manifest was committed and is gone:
  // building on nothing would drop what it held, and reclaim would remove
  // every run as an orphan. Without the lock, the host may be publishing
  // the first manifest while this looks; a tab ignores a generation 0
  // below the one it holds.
  if (underIngestLock) {
    const committed = await committedTrace(fs);
    if (committed) throw new CorruptDatabaseError(`no manifest, but ${committed}`);
  }
  return { meta: GENERATION_ZERO, top };
}

/**
 * What on disk shows a manifest was committed: a log reclaimed past its
 * start, or a run other than the first ingest's L0 (`l0/1-*`).
 */
async function committedTrace(fs: AsyncFs): Promise<string | undefined> {
  if (!(await logsCover(fs, 0))) return "a log was reclaimed, which only follows a committed manifest";
  for (const path of await listRuns(fs)) {
    if (!/^l0\/1-\d+\.sst$/.test(path)) return `run ${path} is on disk`;
  }
  return undefined;
}

/** True when no segment holding a record above `cut` was reclaimed from any tab's log. */
async function logsCover(fs: AsyncFs, cut: number): Promise<boolean> {
  for (const tab of await listTabs(fs)) {
    const first = (await listSegments(fs, tab))[0];
    if (first && parseSegment(first)!.prevStamp > cut) return false;
  }
  return true;
}
