import { CorruptDatabaseError } from "./errors.js";
import { checkCover, type LogFiles } from "./host/queues.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import {
  GENERATION_ZERO,
  isIntact,
  listLogs,
  manifestNumbers,
  probeManifest,
  type GenerationMeta,
} from "./store/generation.js";

/** The manifest the next one builds on, and the highest number in `m/`. */
export type Newest = {
  /** The newest manifest that decodes and whose runs are all on disk. */
  readonly base: GenerationMeta;
  /** The highest manifest number in `m/`: the next manifest numbers past it, so no number names two manifests. */
  readonly top: number;
};

/** What the per-tab ingest queues build on, as recovery found it on disk. */
export type QueueRecovery = Newest & { readonly logs: readonly LogFiles[] };

/**
 * The newest manifest that decodes and lists no run that is gone. A newer
 * one that is empty, or whose run is gone, is what a power loss leaves of a
 * publish, and is skipped. One that does not decode is not, and throws.
 */
export async function newestIntact(fs: AsyncFs): Promise<Newest> {
  const numbers = await manifestNumbers(fs);
  let base = GENERATION_ZERO;
  for (const n of numbers) {
    const m = await probeManifest(fs, n);
    if (m === "corrupt") throw new CorruptDatabaseError(`manifest ${n} does not decode`);
    if (m !== "missing" && (await isIntact(fs, m))) {
      base = m;
      break;
    }
  }
  return { base, top: Math.max(numbers[0] ?? 0, base.generation) };
}

/**
 * `newestIntact`, refused with `CorruptDatabaseError` when the logs on disk
 * no longer hold every record past its cursors (`checkCover`), so a
 * database whose newest manifests vanished never opens with a hole. The
 * check runs for a manifest with no cursors too: a log whose first segment
 * is gone was covered by cursors that vanished with their manifests.
 */
export async function recoverQueues(fs: AsyncFs): Promise<QueueRecovery> {
  const { base, top } = await newestIntact(fs);
  const logs = await listLogs(fs);
  const gap = checkCover(base.queues ?? [], logs);
  if (gap) throw new CorruptDatabaseError(`manifest ${base.generation} cannot find its records: ${gap}`);
  return { base, top, logs };
}
