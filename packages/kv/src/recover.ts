import { CorruptDatabaseError } from "./errors.js";
import { parseSegment } from "./log/frame.js";
import { listSegments, listTabs } from "./log/reader.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import {
  GENERATION_ZERO,
  isIntact,
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
 * files, so the newest manifest may be gone or empty (skipped), or list a
 * run that never reached the disk. Then an older one stands in, but only
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
): Promise<Recovered> {
  const numbers = await manifestNumbers(fs);
  const top = numbers[0] ?? 0;
  let broken: GenerationMeta | undefined;
  for (const n of numbers) {
    const m = await probeManifest(fs, n);
    if (m === "missing") continue;
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (trust(n) || (await isIntact(fs, m))) {
      if (broken && !(await logsCover(fs, m.cut))) {
        throw new CorruptDatabaseError(
          `manifest ${broken.generation} lists a run that is gone, and the logs no longer hold what it covered`,
        );
      }
      return { meta: m, top };
    }
    broken ??= m;
  }
  if (broken && !(await logsCover(fs, 0))) {
    throw new CorruptDatabaseError(`manifest ${broken.generation} lists a run that is gone`);
  }
  return { meta: GENERATION_ZERO, top };
}

/** True when no segment holding a record above `cut` was reclaimed from any tab's log. */
async function logsCover(fs: AsyncFs, cut: number): Promise<boolean> {
  for (const tab of await listTabs(fs)) {
    const first = (await listSegments(fs, tab))[0];
    if (first && parseSegment(first)!.prevStamp > cut) return false;
  }
  return true;
}
