import { scanLog, type ListedSegment } from "../log/queue-scan.js";
import { segmentPath } from "../log/segment.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { listLog } from "../store/generation.js";
import type { LogFiles, LogId, QueueCursor, QueueScan, RecordN } from "./queues.js";

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
