import { CorruptDatabaseError } from "../errors.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import {
  LOG_DIR,
  isTabId,
  parseSegment,
  scanFrames,
  tabDir,
  type LogRecord,
  type Stamp,
  type TabId,
} from "./frame.js";

/** Where a read of one tab's log stopped. */
export type TabPos = {
  /** The segment file name, undefined before the first read. */
  readonly file: string | undefined;
  readonly offset: number;
  /** The last record's `n`; undefined when the next read may start anywhere. */
  readonly n: number | undefined;
  readonly stamp: Stamp;
  /** The read ended on a SEAL: the next one starts at the next segment. */
  readonly sealed: boolean;
};

export const TAB_START: TabPos = { file: undefined, offset: 0, n: 0, stamp: 0, sealed: false };

export type TabRead = {
  readonly records: LogRecord[];
  readonly pos: TabPos;
  /** The tab has no log left: never written, or wholly reclaimed. */
  readonly empty: boolean;
  /**
   * The read went over reclaimed segments, past `pos`: the records it did
   * not see are at or below this stamp, in a generation only. 0 when none.
   */
  readonly reclaimed: Stamp;
};

/** A `getFile()` snapshot throws this when the writer changes the file before it is read (Chrome). */
const NOT_READABLE_RETRIES = 8;

/** Every tab with a log directory. */
export async function listTabs(fs: AsyncFs): Promise<TabId[]> {
  return (await fs.list(LOG_DIR)).filter(isTabId);
}

/** A tab's segment files, oldest first. */
export async function listSegments(fs: AsyncFs, tab: TabId): Promise<string[]> {
  return (await fs.list(tabDir(tab))).filter((f) => parseSegment(f) !== undefined).sort();
}

/**
 * Read `tab`'s log from `pos` to its end with plain `AsyncFs` reads: no
 * lock and no worker. Tabs and the ingest host read this way. A frame being
 * written fails its CRC and ends the read, so the result is a prefix of
 * the log. When segments past `pos` were reclaimed (they held only records
 * a generation covers), the read goes on at the oldest segment left, from
 * the `n` and stamp its name gives. Records at or below `skipThrough` are passed over
 * undecoded (a generation holds them); `pos` still moves past them. It
 * may be a promise, awaited only once the bytes are read.
 *
 * A segment is sealed and flushed before the next one is made, so only a
 * tab's last segment can end in a torn frame. A segment that ends before
 * its SEAL while a later one exists, or a next segment that does not
 * follow on from it, is corruption, not a crash: this throws
 * `CorruptDatabaseError` rather than drop the records past it.
 */
export async function readTab(
  fs: AsyncFs,
  tab: TabId,
  pos: TabPos,
  skipThrough: Stamp | Promise<Stamp> = 0,
): Promise<TabRead> {
  const files = await listSegments(fs, tab);
  if (files.length === 0) return { records: [], pos, empty: true, reclaimed: 0 };
  let n = pos.n;
  let stamp = pos.stamp;
  let offset = pos.offset;
  let i: number;
  // The next segment must follow on from the one before it: false where the read may start anywhere.
  let chained = false;
  if (pos.file === undefined) {
    i = 0;
  } else {
    i = files.indexOf(pos.file);
    if (i === -1) {
      // Reclaimed: go on at the first segment after it.
      i = files.findIndex((f) => f > pos.file!);
      if (i === -1) return { records: [], pos, empty: false, reclaimed: 0 };
      offset = 0;
    } else if (pos.sealed) {
      if (i + 1 >= files.length) return { records: [], pos, empty: false, reclaimed: 0 };
      i += 1;
      offset = 0;
      chained = true;
    }
  }
  const records: LogRecord[] = [];
  let reclaimed: Stamp = 0;
  for (;;) {
    const file = files[i]!;
    if (offset === 0) {
      const seg = parseSegment(file)!;
      if (chained && (seg.firstN !== n! + 1 || seg.prevStamp !== stamp)) {
        throw new CorruptDatabaseError(`log ${tabDir(tab)}/${file} does not follow on from record ${n}`);
      }
      // After reclaimed segments the name says where the log goes on: the
      // `n` and stamp of the record before it. So `n` stays known even
      // when this segment holds no record yet.
      if (n === undefined || seg.firstN !== n + 1) {
        if (n !== undefined && seg.firstN > n + 1) reclaimed = Math.max(reclaimed, seg.prevStamp);
        n = seg.firstN - 1;
        stamp = Math.max(stamp, seg.prevStamp);
      }
    }
    const bytes = await readSegment(fs, `${tabDir(tab)}/${file}`, offset);
    if (!bytes) {
      // Removed after the listing: reclaimed, so the next one goes on.
      if (i + 1 >= files.length) return { records, pos: { file, offset: 0, n, stamp, sealed: false }, empty: false, reclaimed };
      i += 1;
      offset = 0;
      chained = false;
      continue;
    }
    const scan = scanFrames(bytes, n, stamp, await skipThrough);
    for (const r of scan.records) records.push(r);
    n = scan.n;
    stamp = scan.stamp;
    offset += scan.validBytes;
    if (!scan.sealed && i + 1 < files.length) {
      // Reclaim of a dead tab's last segment, cut short: its tombstone is
      // there and it is not removed yet. The rest is corruption.
      if (!(await isTombstoneAfter(fs, tab, files, i + 1, n, stamp))) {
        throw new CorruptDatabaseError(`log ${tabDir(tab)}/${file} breaks off at byte ${offset} before its seal`);
      }
      return { records, pos: { file, offset, n, stamp, sealed: false }, empty: false, reclaimed };
    }
    if (scan.sealed && i + 1 < files.length) {
      i += 1;
      offset = 0;
      chained = true;
      continue;
    }
    return { records, pos: { file, offset, n, stamp, sealed: scan.sealed }, empty: false, reclaimed };
  }
}

/**
 * `files[j]` is the tombstone `reclaimLogs` leaves for a dead tab: its last
 * segment, empty, named right after the record with `n` and `stamp`.
 */
async function isTombstoneAfter(
  fs: AsyncFs,
  tab: TabId,
  files: readonly string[],
  j: number,
  n: number,
  stamp: Stamp,
): Promise<boolean> {
  if (j !== files.length - 1) return false;
  const seg = parseSegment(files[j]!)!;
  if (seg.firstN !== n + 1 || seg.prevStamp !== stamp) return false;
  const bytes = await readSegment(fs, `${tabDir(tab)}/${files[j]}`, 0);
  return !bytes || bytes.byteLength === 0;
}

async function readSegment(fs: AsyncFs, path: string, offset: number): Promise<Uint8Array | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.read(path, offset, Number.POSITIVE_INFINITY);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name !== "NotReadableError" || attempt >= NOT_READABLE_RETRIES) throw err;
    }
  }
}

/** The stamp of the last record in a segment file, or `prevStamp` when it holds none. */
export async function lastStampOf(fs: AsyncFs, tab: TabId, file: string): Promise<Stamp> {
  return (await lastRecordOf(fs, tab, file)).stamp;
}

/** The `n` and stamp of the last record in a segment file, or those before it when it holds none. */
export async function lastRecordOf(fs: AsyncFs, tab: TabId, file: string): Promise<{ n: number; stamp: Stamp }> {
  const seg = parseSegment(file)!;
  const bytes = await readSegment(fs, `${tabDir(tab)}/${file}`, 0);
  if (!bytes) return { n: seg.firstN - 1, stamp: seg.prevStamp };
  const scan = scanFrames(bytes, seg.firstN - 1, seg.prevStamp);
  return { n: scan.n, stamp: scan.stamp };
}
