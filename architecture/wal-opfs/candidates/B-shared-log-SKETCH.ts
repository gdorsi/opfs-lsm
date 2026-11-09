/**
 * Candidate B: one shared, totally ordered WAL on OPFS. Type sketch.
 *
 * Module map (target paths in packages/kv/src):
 *
 *   log/frame.ts      pure codecs: frame, hint, encodeOps/decodeOps (moved from idb/wal.ts), scanFrames
 *   log/segment.ts    SegmentFile (SAH shape) + appendLocked / readFrom / validate: pure policy, Node-testable
 *   log/log-worker.ts dedicated WebWorker entry: Web Lock, group-commit queue, SAH handles, wire protocol
 *   log/client.ts     LogClient (tab side) + openLog(): worker client or in-process client over MemoryFs
 *   store/generation.ts  GenerationMeta gains `walThrough`; the manifest is the commit point
 *   host/ingest.ts    fold sealed segments (getFile), publish manifest, reclaim segments
 *   host/compact.ts   installStep loses its `wal` parameter; carries walThrough forward
 *   host/engine-host.ts  withWal() removed; pendingBytes derived from sealed segment sizes
 *   db.ts             IdBWal -> LogClient; cursor kept next to mem.appliedThrough
 *   idb/              deleted
 */

import type { CheckedOp, DbName } from "../check.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import type { WalRecord } from "../store/memtable.js";
import type { RunMeta } from "../store/generation.js";

// ───────────────────────────── log/frame.ts ─────────────────────────────

/** Segment file path. `base` = first seq the segment holds. */
export function segmentPath(base: number): string {
  return `w/${String(base).padStart(16, "0")}.wal`;
}

export const HINT_BYTES = 32;
/** Rotation threshold. maxWalBytes / 4, so open replays at most maxWalBytes + one segment. */
export const SEGMENT_BYTES = 256 * 1024;
/** u32 bodyLen | u32 crc(kind..body) | u8 kind | u64 seq */
export const FRAME_HEAD = 17;

export const enum FrameKind {
  Record = 1,
  /** Terminal. seq = last Record seq; the next segment is segmentPath(seq + 1). */
  Seal = 2,
}

/** A position in the log: just past the frame that wrote `seq`. */
export type LogPos = {
  /** Base seq of the segment the position is in. */
  readonly segment: number;
  /** Byte offset in that segment, >= HINT_BYTES. */
  readonly offset: number;
  /** Seq of the last record before this position. */
  readonly seq: number;
};

/** A decoded record and the position right after it. */
export type LogRecord = WalRecord & { readonly end: LogPos };

/**
 * Bytes [0, 32) of a segment. A writer's shortcut to the end. Readers never
 * read it. A wrong or torn hint costs a scan, never correctness.
 */
export type Hint = {
  readonly headSeq: number;
  readonly end: number;
  readonly sealed: boolean;
};

export function encodeFrame(kind: FrameKind, seq: number, body: Uint8Array): Uint8Array {
  throw new Error("not implemented");
}
export function encodeHint(hint: Hint): Uint8Array {
  throw new Error("not implemented");
}
/** Undefined when the magic or CRC is bad. */
export function decodeHint(bytes: Uint8Array): Hint | undefined {
  throw new Error("not implemented");
}
export function encodeOps(ops: readonly CheckedOp[]): Uint8Array {
  throw new Error("not implemented"); // moved verbatim from idb/wal.ts
}

/** Where a scan stopped and why. */
export type ScanEnd =
  | { readonly kind: "end"; readonly at: LogPos } // ran out of bytes, or hit a torn frame: the tail so far
  | { readonly kind: "sealed"; readonly at: LogPos; readonly next: number }; // follow to segmentPath(next)

/**
 * Decode frames from `bytes`, which begin at `from.offset` of segment
 * `from.segment`. Stops at the first bad CRC, short frame, seq !==
 * prev + 1, or SEAL. Pure. Main, worker, and host all use it.
 */
export function scanFrames(
  bytes: Uint8Array,
  from: LogPos,
): { readonly records: LogRecord[]; readonly stop: ScanEnd } {
  throw new Error("not implemented");
}

// ──────────────────────────── log/segment.ts ────────────────────────────

/**
 * The synchronous file surface appendLocked needs. A SyncAccessHandle has
 * exactly this shape. Tests use an in-memory implementation.
 */
export interface SegmentFile {
  read(into: Uint8Array, at: number): number;
  write(bytes: Uint8Array, at: number): number;
  truncate(size: number): void;
  getSize(): number;
}

/** Opens or creates a segment handle by base. The only async step under the lock, and only on rotation. */
export type OpenSegment = (base: number, create: boolean) => Promise<SegmentFile | undefined>;

/** One queued append. `expectHead` set means: write only if the log head is exactly there (update fast path). */
export type AppendReq = {
  readonly since: LogPos;
  readonly ops: Uint8Array; // encodeOps output
  readonly expectHead?: number;
};

export type AppendOutcome =
  | { readonly kind: "ok"; readonly seq: number; readonly end: LogPos; readonly gap: Uint8Array; readonly gapFrom: LogPos }
  | { readonly kind: "conflict"; readonly tail: Uint8Array; readonly tailFrom: LogPos }
  | { readonly kind: "behind" }; // `since` segment is gone: caller reloads the latest manifest

/**
 * Writer state cached across lock holds. Always re-validated under the lock,
 * never trusted.
 */
export type WriterState = {
  active: { base: number; file: SegmentFile };
  /** False until this worker's first lock hold has validated the log from walThrough + 1 (power-loss holes). */
  validated: boolean;
};

/**
 * Must run while holding Web Lock `opfs-lsm-wal/<name>`. Group-commits
 * `reqs` in order. Returns one outcome per request.
 */
export async function appendLocked(
  st: WriterState,
  open: OpenSegment,
  reqs: readonly AppendReq[],
): Promise<AppendOutcome[]> {
  // TODO
  // if (!st.validated) { validateFrom(walThrough + 1): scan every segment, truncate at the
  //   first bad frame, delete later segments, rewrite the hint; st.validated = true }   // ~1 ms once
  // let h = decodeHint(read(0, 32)) ?? scanForEnd(st.active.file)
  // if (h.sealed) { st.active = follow(h.headSeq + 1, create = true); h = hint of it }
  // // roll forward: a frame that a dead holder wrote whole and never hinted
  // loop: f = frame at h.end
  //   if (f valid && f.seq === h.headSeq + 1 && f.kind === Record) h = { headSeq: f.seq, end: f.end }
  //   else if (f valid && f.kind === Seal) { /* no write to a sealed file */ st.active = follow(f.seq + 1, true); h = its hint }
  //   else break                                   // nothing, or torn junk: overwritten below
  // let seq = h.headSeq, at = h.end, out: Uint8Array[] = []
  // for (req of reqs):
  //   if (req.since.segment's file is missing) -> behind
  //   if (req.expectHead !== undefined && req.expectHead !== seq) -> conflict { tail = bytes (since, seq] }
  //   frame = encodeFrame(Record, ++seq, req.ops)
  //   if (at + pending + frame > SEGMENT_BYTES && at > HINT_BYTES) {
  //     flush pending; write Seal(seq - 1) at `at`; truncate; write hint { sealed: true }
  //     st.active = await open(seq, true); write hint { headSeq: seq - 1, end: HINT_BYTES }; at = HINT_BYTES
  //   }
  //   append frame to pending; gap = bytes (req.since, seq - 1] read from the files (in-lock, consistent)
  // file.write(concat(pending), at); if (file.getSize() > newEnd) file.truncate(newEnd); write hint
  throw new Error("not implemented");
}

/**
 * Lock-free read for sync(). Reads from `since` to the current end of the
 * segment chain, following SEALs. A frame being written fails its CRC and
 * ends the scan. Every acked frame was written whole before its ack.
 */
export function readFrom(
  since: LogPos,
  fileOf: (base: number) => SegmentFile | undefined,
): { readonly bytes: Uint8Array; readonly from: LogPos } | { readonly kind: "behind" } {
  throw new Error("not implemented");
}

// ─────────────────────────── log/log-worker.ts ───────────────────────────
// Private wire types: not exported from the package, never seen by DbImpl.

export type ToLogWorker =
  | { readonly t: "append"; readonly id: number; readonly req: AppendReq }
  | { readonly t: "lockedTail"; readonly id: number; readonly since: LogPos }
  | { readonly t: "lockedCommit"; readonly id: number; readonly ops: Uint8Array | null }
  | { readonly t: "tail"; readonly id: number; readonly since: LogPos }
  | { readonly t: "seal"; readonly id: number };

export type FromLogWorker =
  | { readonly t: "append"; readonly id: number; readonly out: AppendOutcome }
  | { readonly t: "lockedTail"; readonly id: number; readonly bytes: Uint8Array; readonly from: LogPos }
  | { readonly t: "tail"; readonly id: number; readonly bytes: Uint8Array; readonly from: LogPos }
  | { readonly t: "behind"; readonly id: number }
  | { readonly t: "sealed"; readonly id: number; readonly through: number | undefined }
  | { readonly t: "err"; readonly id: number; readonly message: string };

/**
 * Worker loop (pseudocode):
 *   queue: AppendReq[]; draining = false
 *   on "append": queue.push; if (!draining) drain()
 *   drain(): draining = true
 *     while (queue.length) await navigator.locks.request(LOCK, async () => {
 *       const batch = queue.splice(0)                // group commit: all that arrived while waiting
 *       reply each of await appendLocked(st, open, batch)
 *     })
 *     draining = false
 *   on "lockedTail": navigator.locks.request(LOCK, () => new Promise(release => {
 *       reply tail (read under the lock); park `release` until "lockedCommit" with this id
 *       lockedCommit: ops ? appendLocked(st, open, [{ since: tailEnd, ops, expectHead: head }]) : nothing; release()
 *     }))
 *   on "tail": reply readFrom(since)                 // no lock
 *   on "seal": under the lock, if the active segment holds a record: write SEAL, rotate,
 *       BroadcastChannel { kind: "seal", through, bytes }
 * Handles: createSyncAccessHandle({ mode: "readwrite-unsafe" }). Close a handle
 * once a SEAL in it has been followed, so the host can delete the file.
 */
export function startLogWorker(name: DbName): void {
  throw new Error("not implemented");
}

// ───────────────────────────── log/client.ts ─────────────────────────────

/** What sync() and the gap / conflict paths hand to DbImpl.catchUp. */
export type LogTail = {
  readonly records: readonly LogRecord[];
  /** Position after the last record. Equals `since` when there was nothing new. */
  readonly end: LogPos;
};

/**
 * The tab's handle on the shared log. DbImpl's only WAL dependency. Hides
 * the lock, group commit, rotation, repair, the worker, and getFile reads at open.
 */
export interface LogClient {
  /** Blind append. Resolves once the frame is written. `gap` holds other tabs' records between `since` and this one. */
  append(
    since: LogPos,
    ops: readonly CheckedOp[],
  ): Promise<{ readonly seq: number; readonly end: LogPos; readonly gap: LogTail } | "behind">;
  /**
   * Serializable read-modify-write. `decide` runs synchronously, at most
   * twice: once optimistically on an empty tail at `since`, and once under
   * the lock with the real tail if another write landed first. Undefined
   * from `decide` writes nothing. A throw aborts and rethrows.
   */
  appendAfter<R>(
    since: LogPos,
    decide: (tail: LogTail) => { readonly ops: readonly CheckedOp[]; readonly result: R } | undefined,
  ): Promise<
    | { readonly seq: number | undefined; readonly end: LogPos; readonly result: R }
    | undefined
    | "behind"
  >;
  /** Everything committed after `since`. Lock-free. */
  tail(since: LogPos): Promise<LogTail | "behind">;
  /** Seal the active segment so ingest can take it. Undefined when it held no record. */
  seal(): Promise<number | undefined>;
  close(): void;
}

/**
 * Browser: start the log worker (~10 ms) without awaiting it. Read the tail
 * from `w/<walThrough + 1>` with getFile while it starts: one
 * slice().arrayBuffer() per segment, retried on NotReadableError up to 3
 * times, then through the worker. Node/tests: an in-process client over
 * MemoryFs segment files and an in-process mutex. Same appendLocked.
 */
export async function openLog(
  name: DbName,
  fs: AsyncFs,
  walThrough: number,
): Promise<{ readonly client: LogClient; readonly initial: LogTail }> {
  throw new Error("not implemented");
}

// ─────────────────────────── store/generation.ts ───────────────────────────

export type GenerationMeta = {
  readonly generation: number;
  readonly runs: readonly RunMeta[];
  readonly tombstoneSeq: number;
  /**
   * Every seq <= walThrough is in `runs`, and no seq above it is. It
   * replaces IDB's (generation, ingestedThrough) pair. Publishing the
   * manifest (createWritable + close, atomic) is the commit point.
   * Always a SEAL seq, so segmentPath(walThrough + 1) is the first live segment.
   */
  readonly walThrough: number;
};

// ───────────────────────────── host/ingest.ts ─────────────────────────────

export type IngestResult = {
  readonly generation: number;
  readonly walThrough: number;
  readonly foldedBytes: number;
};

/**
 * Compaction-shaped. Runs in the SharedWorker.
 *   prev = loadLatestGeneration(fs)                       // no lock
 *   follow segmentPath(prev.walThrough + 1) and its SEALs via fs.read (getFile).
 *     Take only sealed segments, which never change, so no NotReadableError.
 *     Stop at the first unsealed one, or once SEAL.seq >= through.
 *   entries = foldRecords(records); l0 = publishL0(fs, `${first}-${last}`, entries)   // no lock
 *   under Web Lock opfs-lsm-ingest/<name>:                // short install
 *     cur = loadLatestGeneration(fs); if (cur.walThrough >= last) return cur   // someone else did it: l0 is garbage
 *     publishGeneration(fs, { generation: cur.generation + 1, runs: [l0, ...cur.runs],
 *                             tombstoneSeq: cur.tombstoneSeq, walThrough: last })   // COMMIT
 *   broadcast { kind: "ingest", generation }
 *   reclaimSegments(fs, last); reclaimManifests(fs, generation)   // best-effort, idempotent
 *   (A compaction install between the fold and the install is fine: L0 is
 *   prepended to cur.runs, and cur.walThrough is still < first.)
 */
export async function ingestSealed(fs: AsyncFs, through: number): Promise<IngestResult> {
  throw new Error("not implemented");
}

/** Delete every segment with base <= walThrough. A failure (an idle tab's handle still open) is retried by the next ingest. */
export async function reclaimSegments(fs: AsyncFs, walThrough: number): Promise<void> {
  throw new Error("not implemented");
}

// ─────────────────────────────── db.ts (delta) ───────────────────────────────
/*
 * DbImpl changes. Memtable, view, and reads are untouched.
 *
 *   private at: LogPos                      // invariant: at.seq === mem.appliedThrough
 *   private apply(r: LogRecord): boolean    { if (!mem.apply(r)) return false; at = r.end; return true }
 *
 *   batch(ops):   r = await log.append(at, ops)
 *                 r === "behind" ? (await jumpToLatest(), retry) : (gap.records.forEach(apply), apply({seq, ops, end}))
 *                 broadcast { kind: "append", writerId, seq, ops, end }
 *   update(...):  log.appendAfter(at, tail => { catchUp(tail); return plan() })   // plan may run twice
 *   sync():       t = await log.tail(at); catchUp(t)        // ~25 µs; installs a generation when a hint set `pendingGen`
 *   onMessage:    append -> apply({seq, ops, end}) || sync()
 *                 ingest {generation} -> load(generation); install when meta.walThrough <= mem.appliedThrough,
 *                 else mem.advanceTo(walThrough), at = { segment: walThrough + 1, offset: HINT_BYTES, seq: walThrough }
 *   jumpToLatest(): meta = loadLatestGeneration(fs); install as above   // the cursor segment was reclaimed
 *   open:         meta = loadLatestGeneration(tabFs); install(meta); { client, initial } = openLog(name, fs, meta.walThrough);
 *                 initial.records.forEach(apply)
 *   close():      log.close()
 */
