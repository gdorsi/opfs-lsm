import { scanLog, type ListedSegment } from "../log/queue-scan.js";
import { segmentPath } from "../log/segment.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { recoverQueues } from "../recover.js";
import { foldRecords } from "../store/fold.js";
import {
  listLog,
  listLogs,
  manifestNumbers,
  publishGeneration,
  publishL0,
  readManifest,
  reclaimManifests,
} from "../store/generation.js";
import {
  planIngest,
  planReclaim,
  type DurableHints,
  type LogFiles,
  type LogId,
  type QueueCursor,
  type QueueScan,
  type RecordN,
} from "./queues.js";

/**
 * The per-log Web Locks, `opfs-lsm-log/<db>/<log>`. A log's writer, its
 * dedicated WebWorker, takes the lock before it creates `w/<log>/` and
 * holds it until it ends, so a lock the host can take means a writer that
 * never writes again.
 */
export interface LogLocks {
  /** Takes the log's lock if it is free and returns its release; undefined while its writer holds it. */
  take(log: LogId): Promise<(() => void) | undefined>;
}

/** Reads of a segment that Chrome refuses with `NotReadableError` (a writer is appending to it) before it counts as unreadable this round. */
const READ_TRIES = 8;

/** What an ingest round tells the pages. */
export type IngestOutcome = {
  /** The newest manifest: the one this round published, or its base when it had nothing to add. */
  readonly generation: number;
  /** Live logs that hit a hole: their tabs start a new log and append again what they still hold. */
  readonly damagedLive: readonly LogId[];
};

/**
 * One ingest round: recover the base manifest, scan the logs, plan, then
 * publish one L0 with the plan's records at their seqs and a manifest with
 * the new cursors. Run it under the ingest lock, which every manifest
 * publish and `reclaimQueues` hold too.
 *
 * Idempotent: the cursors commit with the runs that hold their records,
 * so a round that dies before its manifest leaves the base as it was, and
 * the next round plans again from it; one that publishes leaves nothing to
 * redo. A round with nothing to add publishes nothing.
 */
export async function ingestQueues(fs: AsyncFs, locks: LogLocks, durable: DurableHints, maxBytes: number): Promise<IngestOutcome> {
  const { base, top, logs } = await recoverQueues(fs);
  const queues = base.queues ?? [];
  return scanQueues(fs, locks, queues, logs, async (scans) => {
    const plan = planIngest({ through: base.through, queues }, scans, durable, maxBytes);
    if (plan.records.length === 0 && sameCursors(plan.queues, queues)) return { generation: base.generation, damagedLive: plan.damagedLive };
    const runs =
      plan.records.length === 0 ? base.runs : [await publishL0(fs, `${base.through + 1}-${plan.through}`, foldRecords(plan.records)), ...base.runs];
    const generation = top + 1;
    await publishGeneration(fs, { generation, runs, tombstoneSeq: base.tombstoneSeq, through: plan.through, queues: plan.queues });
    return { generation, damagedLive: plan.damagedLive };
  });
}

const sameCursors = (a: readonly QueueCursor[], b: readonly QueueCursor[]): boolean =>
  a.length === b.length && a.every((c, i) => c.log === b[i]!.log && c.state === b[i]!.state && c.n === b[i]!.n);

/**
 * Deletes what `planReclaim` finds every kept manifest covers: finished
 * segments, the directory of a dead log they all have final, and the
 * manifests past the kept ones. A log is dead only when this takes its
 * lock. A delete that fails is left for the next pass: Chrome and Firefox
 * refuse to remove a file a writer holds open. Run it under the ingest
 * lock, and only while no tab loads a generation (`unlessHeld`).
 *
 * Every delete is safe on its own, so a pass that dies partway leaves a
 * state the next pass plans from again.
 */
export async function reclaimQueues(fs: AsyncFs, locks: LogLocks): Promise<void> {
  const manifests: { generation: number; queues: readonly QueueCursor[] }[] = [];
  for (const generation of await manifestNumbers(fs)) {
    const meta = await readManifest(fs, generation);
    if (meta) manifests.push({ generation, queues: meta.queues ?? [] });
  }
  const logs = await listLogs(fs);
  const held = new Map<LogId, () => void>();
  try {
    for (const { log } of logs) {
      const release = await locks.take(log);
      if (release) held.set(log, release);
    }
    const plan = planReclaim(manifests, logs, new Set(held.keys()));
    for (const { log, firstN } of plan.segments) await removeQuietly(fs, segmentPath(log, firstN));
    for (const { log, segments } of logs.filter((l) => plan.logs.includes(l.log))) {
      for (const firstN of segments) await removeQuietly(fs, segmentPath(log, firstN));
      await removeQuietly(fs, `w/${log}`);
    }
    if (plan.manifests.length > 0) await reclaimManifests(fs, Math.max(...plan.manifests) + 1);
  } finally {
    for (const release of held.values()) release();
  }
}

async function removeQuietly(fs: AsyncFs, path: string): Promise<void> {
  try {
    await fs.remove(path);
  } catch {}
}

/**
 * Reads every log in `logs` that is not final or damaged in `queues`, from
 * its cursor, and hands the scans to `use`. A log is dead only when this
 * takes its lock; its segments are then listed again under the lock, since
 * `logs` may predate its last segment. The locks stay held until `use`
 * settles, so a log is still dead when the manifest that makes it final
 * is published.
 */
export async function scanQueues<T>(
  fs: AsyncFs,
  locks: LogLocks,
  queues: readonly QueueCursor[],
  logs: readonly LogFiles[],
  use: (scans: readonly QueueScan[]) => Promise<T>,
): Promise<T> {
  const cursors = new Map(queues.map((c) => [c.log, c]));
  const held: (() => void)[] = [];
  try {
    const scans: QueueScan[] = [];
    for (const listed of logs) {
      const cursor = cursors.get(listed.log);
      if (cursor && cursor.state !== "open") continue;
      const release = await locks.take(listed.log);
      if (release) held.push(release);
      const { segments } = release ? await listLog(fs, listed.log) : listed;
      const from = cursor?.n ?? 0;
      scans.push(scanLog(listed.log, from, release !== undefined, await readFrom(fs, listed.log, segments, from)));
    }
    return await use(scans);
  } finally {
    for (const release of held) release();
  }
}

/**
 * The segments that can hold record `from + 1` or later. One wholly at or
 * below the cursor is not read: its records are in the runs, and its
 * header's pred no longer matters, since the planner took the log's first
 * record only once the pred was final or damaged.
 */
async function readFrom(fs: AsyncFs, log: LogId, firsts: readonly RecordN[], from: RecordN): Promise<ListedSegment[]> {
  let start = 0;
  firsts.forEach((firstN, i) => {
    if (firstN <= from + 1) start = i;
  });
  const out: ListedSegment[] = [];
  for (const firstN of firsts.slice(start)) out.push({ firstN, bytes: await readSegment(fs, segmentPath(log, firstN)) });
  return out;
}

/**
 * A segment's bytes, which may be a prefix of what is written. Unreadable
 * when Chrome refuses every try, or when the file is gone since the
 * listing: the scan stops there for this round and the next one lists again.
 */
async function readSegment(fs: AsyncFs, path: string): Promise<Uint8Array | "unreadable"> {
  for (let i = 0; i < READ_TRIES; i++) {
    try {
      return (await fs.read(path, 0, Number.POSITIVE_INFINITY)) ?? "unreadable";
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name !== "NotReadableError") throw err;
    }
  }
  return "unreadable";
}
