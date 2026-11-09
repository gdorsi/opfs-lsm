/**
 * Candidate A: per-writer OPFS logs, no shared sequencer.
 *
 * Module map (target paths in packages/kv/src):
 *
 *   wal/stamp.ts          Stamp, Slot, Frontier, LamportClock, deps check. Pure.
 *   wal/format.ts         Record framing (len | crc | body), parseSegment. Pure.
 *   wal/epoch.ts          The epoch lock protocol: writer lease (shared) and barrier
 *                         (exclusive + `yield` broadcast). Sole owner of that lock.
 *   wal/writer-worker.ts  Dedicated WebWorker: SAH append, rotate/seal, torn-tail recovery.
 *   wal/writer.ts         Main-thread SlotWriter: slot lock, worker, lease, append.
 *   wal/reader.ts         LogReader: per-slot cursors over getFile(); tabs and host.
 *   store/generation.ts   + covers/maxStamp in GenerationMeta, CURRENT pointer.
 *   store/memtable.ts     apply() by LWW stamp + Frontier instead of appliedThrough.
 *   store/fold.ts         foldRecords sorts by stamp first.
 *   host/ingest.ts        barrier cut → fold → publish → CURRENT → reclaim segments.
 *   host/compact.ts       installStep swaps CURRENT instead of wal.raiseGeneration.
 *   db.ts                 DbImpl wiring. Public Db API unchanged.
 *   idb/wal.ts            DELETED. No IndexedDB anywhere.
 *
 * Call chain for a put: db.ts → wal/writer.ts → (postMessage) wal/writer-worker.ts.
 * Call chain for sync: db.ts → wal/reader.ts → store/memtable.ts.
 */

import type { CheckedOp, DbName } from "../check.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import type { RunMeta } from "../store/generation.js";

// ─────────────────────────────────────────────── wal/stamp.ts (pure)

declare const slotBrand: unique symbol;
/** 0..255. Held through Web Lock `opfs-lsm-slot/<name>/<slot>` by one live Db. */
export type Slot = number & { readonly [slotBrand]: true };
export const MAX_SLOTS = 256;

declare const stampBrand: unique symbol;
/**
 * lamport * 256 + slot. Unique across writers, totally ordered, < 2^53.
 * Replaces the global seq wherever seqs are compared (MemRow.seq, SstEntry.seq,
 * tombstoneSeq). Higher stamp wins a conflict.
 */
export type Stamp = number & { readonly [stampBrand]: true };

/**
 * localSeq applied per slot; index = slot, 0 = none. A Frontier always names a
 * per-slot prefix that is causally closed. A view pins one.
 */
export type Frontier = readonly number[];

export function stampOf(lamport: number, slot: Slot): Stamp {
  throw new Error("not implemented");
}

/** frontier[s] >= deps[s] for every s. */
export function covers(frontier: Frontier, deps: Frontier): boolean {
  throw new Error("not implemented");
}

/** Pointwise max. Union of two causally closed cuts is closed. */
export function joinFrontier(a: Frontier, b: Frontier): Frontier {
  throw new Error("not implemented");
}

/** Raised past every stamp this writer applies; `next` is strictly above all of them. */
export class LamportClock {
  constructor(readonly slot: Slot) {}
  observe(stamp: Stamp): void {
    throw new Error("not implemented");
  }
  next(): Stamp {
    throw new Error("not implemented");
  }
}

// ─────────────────────────────────────────────── wal/format.ts (pure)

/** One acked batch from one slot. The unit the memtable applies and ingest folds. */
export type LogRecord = {
  readonly slot: Slot;
  readonly localSeq: number;
  readonly stamp: Stamp;
  /** Writer's frontier when it wrote; the reader must have applied it first. */
  readonly deps: Frontier;
  readonly ops: readonly CheckedOp[];
};

/**
 * record = u32 bodyLen | u32 crc32(body) | body
 * body   = u8 kind (0 batch, 1 seal) | u32 localSeq | f64 stamp
 *        | u8 nDeps (0xFF = same as previous record) | nDeps × (u8 slot, u32 localSeq)
 *        | encodeOps bytes
 * `previousDeps` is passed so the encoder can write 0xFF.
 */
export function encodeRecord(rec: LogRecord, previousDeps: Frontier | undefined): Uint8Array {
  throw new Error("not implemented");
}

export type ParsedSegment = {
  readonly records: readonly LogRecord[];
  /** Byte offset after the last whole, CRC-valid record. Resume reading here. */
  readonly validEnd: number;
  /** The segment ends with a seal record: the slot continues in `<nextLocalSeq>.log`. */
  readonly sealed: boolean;
  /** deps of the last record, to resolve a following 0xFF. */
  readonly lastDeps: Frontier | undefined;
};

/**
 * Parse from `offset`. Stops at a length past EOF or a CRC mismatch: a torn tail
 * or an append still in progress. Never throws on those; throws CorruptDatabaseError
 * only for a valid CRC over a malformed body.
 */
export function parseSegment(
  slot: Slot,
  bytes: Uint8Array,
  offset: number,
  prevDeps: Frontier | undefined,
): ParsedSegment {
  throw new Error("not implemented");
}

export function segmentPath(slot: Slot, firstLocalSeq: number): string {
  return `wal/${slot}/${String(firstLocalSeq).padStart(10, "0")}.log`;
}

// ─────────────────────────────────────────────── wal/epoch.ts

/**
 * Owns Web Lock `opfs-lsm-epoch/<name>` and the `yield` message. Shared mode is a
 * writer's lease; exclusive mode is a barrier. Barrier property: every record
 * written before a barrier has a lower stamp than every record written after,
 * because a writer runs `onLeaseAcquired` (a full sync) before its first append
 * under each lease.
 */
export interface Epoch {
  /**
   * Resolve once this writer holds the lease. When it had to (re)acquire it,
   * `onLeaseAcquired` has completed before this resolves.
   */
  lease(): Promise<void>;
  /** Run `fn` with every lease released, including this writer's own. */
  barrier<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

export function openEpoch(
  name: DbName,
  opts: {
    /** Catch up every log: raises the Lamport clock past every earlier stamp. */
    onLeaseAcquired: () => Promise<void>;
    /** Resolves when this writer's in-flight appends have acked. */
    drain: () => Promise<void>;
  },
): Epoch {
  // TODO lease():
  //   if held → return
  //   await navigator.locks.request(EPOCH, { mode: "shared" }, () => heldUntil(releaseSignal))
  //   (resolve lease() from inside the grant callback, keep the callback pending)
  //   await onLeaseAcquired()
  // TODO release triggers: bus "yield", visibilitychange→hidden, freeze, pagehide, close:
  //   stop granting new appends → await drain() → resolve releaseSignal
  // TODO barrier(fn):
  //   release own lease (after drain)
  //   const granted = navigator.locks.request(EPOCH, { mode: "exclusive" }, fn)
  //   post { kind: "yield" } now and every 50 ms until granted starts
  //   return granted
  // Fairness assumption: a shared request queued after a pending exclusive waits.
  throw new Error("not implemented");
}

// ─────────────────────────────────────────────── wal/writer-worker.ts (dedicated WebWorker)

export type WorkerIn =
  | { readonly type: "open"; readonly name: DbName; readonly slot: Slot; readonly coveredThrough: number }
  | { readonly type: "append"; readonly id: number; readonly bytes: ArrayBuffer }
  | { readonly type: "close" };

export type WorkerOut =
  | { readonly type: "opened"; readonly nextLocalSeq: number }
  | { readonly type: "appended"; readonly id: number }
  | { readonly type: "err"; readonly id?: number; readonly message: string };

/**
 * Only code that writes log files. One SAH, exclusive, never flushed.
 */
export function writerWorkerMain(self: DedicatedWorkerGlobalScope): void {
  // TODO "open":
  //   list wal/<slot>/; if empty → nextLocalSeq = coveredThrough + 1
  //   else open SAH on the last segment, parseSegment from 0;
  //     truncate(validEnd); if !sealed append seal(nextLocalSeq); close SAH
  //   create segmentPath(slot, nextLocalSeq), open SAH, reply opened
  // TODO "append": sah.write(bytes, { at: end }); end += n;
  //   if end > 64 KiB: write seal, close, create next segment, open SAH
  //   reply appended (no flush: durability = written to the SAH)
  throw new Error("not implemented");
}

// ─────────────────────────────────────────────── wal/writer.ts (main thread)

/** This Db's slot and the worker that appends to it. */
export interface SlotWriter {
  readonly slot: Slot;
  /**
   * Append one batch. Takes the lease if needed (which syncs first), stamps it
   * with clock.next() and the current frontier as deps, posts to the worker,
   * resolves at the worker's ack.
   */
  append(ops: readonly CheckedOp[]): Promise<LogRecord>;
  /**
   * The serialized path for `update` and multi-key `batch`: barrier, full sync,
   * `plan` against the caught-up state, append. `plan` is synchronous.
   */
  appendAtBarrier<R>(
    plan: () => { readonly ops: readonly CheckedOp[]; readonly result: R },
  ): Promise<{ readonly record: LogRecord | undefined; readonly result: R }>;
  close(): Promise<void>;
}

export async function openSlotWriter(
  name: DbName,
  fs: AsyncFs,
  hooks: {
    /** DbImpl.sync, bound. Also feeds the clock through memtable applies. */
    sync: () => Promise<void>;
    frontier: () => Frontier;
    clock: LamportClock;
    coveredThrough: (slot: Slot) => number;
  },
): Promise<SlotWriter> {
  // TODO for i in 0..MAX_SLOTS: request opfs-lsm-slot/<name>/<i> { ifAvailable }; keep first grant
  //   (none free → wait on slot 0..N without ifAvailable, documented limit)
  // TODO spawn worker (~10 ms) without awaiting; append() awaits `opened`
  // TODO openEpoch(name, { onLeaseAcquired: hooks.sync, drain: inFlight })
  throw new Error("not implemented");
}

// ─────────────────────────────────────────────── wal/reader.ts (main thread and SharedWorker)

type SlotCursor = { segment: number; offset: number; lastDeps: Frontier | undefined };

export type ReadResult =
  | { readonly kind: "records"; readonly records: readonly LogRecord[] }
  /** A segment this reader needs is gone: a newer generation covers it. */
  | { readonly kind: "ingested"; readonly slot: Slot };

/**
 * Reads other writers' logs through getFile(). Never holds a handle open.
 * Shared by DbImpl.sync and host ingest, so framing knowledge lives in one place.
 */
export class LogReader {
  private cursors = new Map<Slot, SlotCursor>();

  constructor(private readonly fs: AsyncFs) {}

  /** Start every slot at covers[slot] + 1 (after installing a generation). */
  resetTo(covered: Frontier): void {
    throw new Error("not implemented");
  }

  /**
   * Read every known slot from its cursor to the current end, plus probe
   * wal/<maxKnown+1>. With `until`, stop at those byte ends (the ingest cut).
   */
  readAll(until?: ReadonlyMap<Slot, { segment: number; end: number }>): Promise<ReadResult> {
    // TODO per slot: file = await handle.getFile(); if file.size <= offset → skip
    //   bytes = await file.slice(offset).arrayBuffer()
    //     catch NotReadableError → retry getFile (bounded)
    //   parsed = parseSegment(...); offset = validEnd
    //   if parsed.sealed → move to the next segment, loop
    //   NotFoundError on a segment → return { kind: "ingested", slot }
    throw new Error("not implemented");
  }

  /** Byte ends of every live segment. Called inside the ingest barrier only. */
  measureEnds(): Promise<ReadonlyMap<Slot, { segment: number; end: number }>> {
    throw new Error("not implemented");
  }
}

// ─────────────────────────────────────────────── store/generation.ts (additions)

export type GenerationMetaA = {
  readonly generation: number;
  readonly runs: readonly RunMeta[];
  readonly tombstoneSeq: number;
  /** Every record at or below covers[slot] is in `runs`. A causally closed cut. */
  readonly covers: Frontier;
  /** Highest stamp folded. Every record outside `covers` has a higher stamp. */
  readonly maxStamp: Stamp;
};

/** The commit point. Written via createWritable (atomic swap on close). */
export function readCurrent(fs: AsyncFs): Promise<number> {
  throw new Error("not implemented");
}
export function writeCurrent(fs: AsyncFs, generation: number): Promise<void> {
  throw new Error("not implemented");
}

// ─────────────────────────────────────────────── store/memtable.ts (changes)

export interface MemtableA {
  readonly frontier: Frontier;
  /**
   * Apply if record.localSeq == frontier[slot] + 1 and covers(frontier, deps).
   * Per row: replace only when record.stamp > row.seq. Returns "gap" | "deps" when
   * it cannot apply, so the caller syncs. Order-independent: the result depends only
   * on the set of records applied.
   */
  apply(record: LogRecord): "applied" | "dup" | "gap" | "deps";
  /** Install a generation: drop rows with stamp <= maxStamp; frontier = join(frontier, covers). */
  advanceTo(maxStamp: Stamp, covered: Frontier): void;
}

// ─────────────────────────────────────────────── host/ingest.ts

export type IngestResultA = {
  readonly generation: number;
  readonly covers: Frontier;
  readonly foldedBytes: number;
};

/**
 * Runs under opfs-lsm-ingest/<name>. The only stop-the-writers moment is the
 * barrier around measureEnds(); the fold and the publish are private work.
 */
export async function ingestAll(
  fs: AsyncFs,
  epoch: Pick<Epoch, "barrier">,
): Promise<IngestResultA> {
  // TODO
  //   cur  = load manifest readCurrent(fs)                 (covers, maxStamp, runs)
  //   cut  = await epoch.barrier(() => reader.measureEnds())   // short
  //   reader.resetTo(cur.covers); res = await reader.readAll(cut)
  //   if no records → return cur
  //   entries = foldRecords(records sorted by stamp)        // last stamp per key wins
  //   l0 = publishL0(fs, `g${G+1}`, entries)                 // overwrite-safe on retry
  //   publishGeneration(fs, { G+1, [l0, ...cur.runs], covers: cutFrontier, maxStamp })
  //   writeCurrent(fs, G+1)                                  // COMMIT
  //   reclaimManifests(fs, G+1)
  //   reclaimSegments(fs, cutFrontier)
  throw new Error("not implemented");
}

/**
 * Delete segments whose last localSeq <= covered[slot] and that are sealed, or
 * whose slot lock the host gets with ifAvailable (dead writer, no SAH open).
 * Idempotent: a crash before or during it only leaves files for the next ingest.
 */
export async function reclaimSegments(fs: AsyncFs, covered: Frontier): Promise<void> {
  throw new Error("not implemented");
}

// ─────────────────────────────────────────────── db.ts (DbImpl, changed parts)

/** BroadcastChannel opfs-lsm-layers/<name>. */
export type BusMessageA =
  | { readonly kind: "append"; readonly writerId: string; readonly record: LogRecord }
  | { readonly kind: "ingest"; readonly writerId: string }
  | { readonly kind: "yield"; readonly writerId: string };

/**
 * Sketch of the DbImpl write paths. Reads (get, range, view, rangeFollow) are
 * unchanged: memtable first, then levels newest first. view pins
 * (mem.frontier, installed.generation, mem.pin(), levels).
 */
export interface DbImplWritesA {
  /**
   * 1 distinct key: writer.append (lease, no lock per write) → mem.apply → broadcast.
   * ≥2 distinct keys: writer.appendAtBarrier, so it is never concurrent with any write.
   */
  batch(ops: readonly CheckedOp[]): Promise<void>;
  /** writer.appendAtBarrier(() => run body on memtable+SST). Strictly serializable. */
  update<T>(keys: readonly Uint8Array[], body: (values: readonly (Uint8Array | undefined)[]) => T): Promise<T>;
  /**
   * reader.readAll(); apply each record; records refused for "deps" get one more
   * pass over the named slots; "ingested" → readCurrent, load manifest, install,
   * reader.resetTo(covers), retry (bounded, like GENERATION_RETRIES today).
   */
  sync(): Promise<void>;
  /** From the bus: apply if mem.apply(record) == "applied", else sync(). */
  onAppend(record: LogRecord): void;
}
