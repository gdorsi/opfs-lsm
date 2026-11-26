import { Backpressure, memtableCaps, type MemtableCaps } from "./backpressure.js";
import { successor } from "./bytes.js";
import {
  CheckedBatch,
  checkDbName,
  checkKey,
  newWriterId,
  flushBytes,
  type BatchOp,
  type CheckedKey,
  type CheckedOp,
  type DbName,
  type WriterId,
} from "./check.js";
import {
  ClosedError,
  CommitError,
  ConstraintError,
  CorruptDatabaseError,
  StorageFullError,
  StorageUnavailableError,
  codeOfError,
  unavailable,
} from "./errors.js";
import { compactionMemoryOf, DEFAULT_MAX_WAL_BYTES, reserveOf } from "./host/budget.js";
import { createPortIngestClient } from "./host/port-client.js";
import { holdingFiles, type BusMessage, type BusRow, type IngestClient, type StorageFull, type WatchPolicy } from "./host/protocol.js";
import { removeDatabase } from "./destroy.js";
import { fullLock, layersChannel, openLock, webLocks, withLock } from "./locks.js";
import { TabWal, decodeOps, encodeOps, resolveOps, rowValid, type WalTail } from "./idb/wal.js";
import { reconcileOpen } from "./recover.js";
import { GENERATION_NONE, SEQ_ZERO, nextSeq, type Generation, type Seq } from "./seq.js";
import { Memtable, type MemRow, type WalRecord } from "./store/memtable.js";
import { Miss, ReadSet, type Entry, type Maybe } from "./store/cursor.js";
import { coalesced } from "./turns.js";
import type { OpenFile, ReadFs, RemovableFolder } from "./opfs/async-fs.js";
import { findRemovableBrowserFs, openBrowserReadFs, openParent } from "./opfs/browser-fs.js";
import { loadGeneration, runsOfCopy, type GenerationMeta } from "./store/generation.js";
import { NO_MARKS, type Marks } from "./store/marks.js";
import { countOf, keysReader, pointGet, runLevels, type RunLevel } from "./store/read.js";
import { ensureEngine } from "./store/engine.js";
import { DEFAULT_BUDGET, PageCache } from "./store/page-cache.js";
import { SstReader } from "./store/sst-reader.js";
import { ViewSnapshotImpl, boundsOf, rangeScan, scanStep, type Decode, type ViewSnapshot } from "./view.js";
import type { ChangeEvent, ChangeListener } from "./changes.js";

export type { Entry } from "./store/cursor.js";
export type { Decode, ViewSnapshot } from "./view.js";
export type { StorageFull } from "./host/protocol.js";
export type { ChangeEvent, ChangeListener, ChangeKind, ChangeOp } from "./changes.js";

/** Public open options. Apps pass a database name; the library owns the rest. */
export type OpenOptions = {
  readonly name: string;
  /**
   * Bytes of run files this tab keeps in memory: cached data blocks and
   * Bloom filters. Default 256 MiB, at least 1 MiB. It does not cover the
   * block indexes of the manifest, the memtable, the wasm heap, or values
   * handed to the caller. Each `openDb` has its own budget.
   */
  readonly cacheBytes?: number;
  /**
   * Bytes this tab's memtable may hold: the rows written and not yet flushed
   * to OPFS, counted as key bytes, value bytes and an estimate per row.
   * Default 16 MiB, at least 1 MiB. At 7/8 of it the tab asks the host to
   * flush and keeps writing. At the limit a write waits for that flush, so
   * a writing tab's memtable stays near the limit. The host flushes once the
   * WAL passes 7/8 of the smallest limit any open tab set.
   */
  readonly memtableBytes?: number;
  /**
   * Bytes the SharedWorker may spend on flushing and compacting this
   * database: its wasm heap and the run data in flight. Default 32 MiB, at
   * least 8 MiB. A smaller figure gives smaller flush runs and a smaller read
   * window, and under about 17.5 MiB fewer runs in one compaction step. The host's
   * figures stop growing at 64 MiB. When tabs differ, the host uses the
   * smallest, until the last tab closes the database. It counts memory that is alive, not garbage the browser has not
   * collected yet.
   */
  readonly compactionMemoryBytes?: number;
  /**
   * Bytes the SharedWorker keeps written in a reserve file, and removes when
   * the browser refuses a write, so the write and the flush and compaction
   * that free space have room (docs/reserve.md). Default 24 MiB, an
   * integer of at least 0. 0 keeps none, and never calls `onStorageFull`.
   * When tabs differ, the host keeps the largest, until the last tab closes
   * the database.
   */
  readonly reserveBytes?: number;
};

type StorageFullHandler = (full: StorageFull) => Promise<void>;

/** Below this, one page per merge source may not fit. */
const MIN_MEMORY_BUDGET = 1024 * 1024;

/**
 * What an open runs on: where this tab reads the run files, who flushes
 * them, and the handle's settings. `openDb` passes the browser's, and
 * `@opfs-lsm/kv/testing` builds one from a test's options.
 */
export type OpenParts = {
  readonly fs: ReadFs;
  readonly ingest: IngestClient;
  /** Close `ingest` with the handle. */
  readonly ownsIngestClient: boolean;
  readonly writerId: WriterId;
  /** See `ROW_POST_MS`. */
  readonly rowPostMs: number;
  /** See `DEFAULT_MAX_WAL_BYTES`. The host uses the smallest limit across tabs. */
  readonly maxWalBytes: number;
};

export type Range = {
  /** Inclusive. Bounds are in key order whichever way `reverse` points. */
  readonly start?: Uint8Array;
  /** Exclusive. */
  readonly endExclusive?: Uint8Array;
  /** At most this many entries, taken in scan order, so the largest keys with `reverse`. */
  readonly limit?: number;
  /**
   * Pass over this many entries, in scan order, before the first one. `limit`
   * counts from there. An entry passed over is not copied.
   */
  readonly offset?: number;
  /**
   * Scan from the largest key down. Yields the keys of the forward scan in
   * descending order. To page backward, pass the last key seen as
   * `endExclusive`.
   */
  readonly reverse?: boolean;
  /**
   * Keep only puts whose current value contains every one of these byte
   * strings. Runs are matched inside the wasm engine one block at a time, so
   * a block with no match costs no JS per row. `limit` counts matches.
   */
  readonly valueContains?: readonly Uint8Array[];
};

/** `start` inclusive, `endExclusive` exclusive, either open. `prefixBound` returns one. */
export type KeyBounds = {
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
};

export type DeleteRangeOptions = {
  /**
   * Remove only rows last written at or before this seq: a write's ack, a
   * `view`'s `snap.seq`, a change event's seq. Default: every row written
   * before this batch. Either way it stops below this batch's own seq, so a
   * range delete never removes its batch's writes.
   */
  readonly through?: number;
};

/**
 * Each op copies its bytes when it is called, so the caller may reuse a
 * buffer for the next op. A tx used after its callback returned throws
 * `ConstraintError`.
 */
export interface BatchTx {
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
  /**
   * Every row in `bounds` last written at or before `through` reads as
   * absent from this batch on, in every tab, and older versions of those
   * keys with it. One op whatever the range holds: it leaves no tombstone
   * per key. `ConstraintError` when `start` is not below `endExclusive`.
   */
  deleteRange(bounds: KeyBounds, options?: DeleteRangeOptions): void;
}

export interface Db {
  /** The name passed to `openDb`. */
  readonly name: string;
  readonly writerId: WriterId;
  /**
   * A copy of the value. Every read hands out copies of keys and values, and
   * a copy of 65 bytes to 1 KiB is a view of a buffer shared with other copies, as Node's
   * Buffer pool makes them: read it through `byteOffset`, a multiple of 8,
   * and `byteLength`. Posting or storing it clones the whole shared buffer,
   * and transferring that buffer detaches the other copies, so `slice()` it
   * before you post, store, transfer or keep it.
   */
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /**
   * `get` of every key, in the order of `keys`, as one read: every key sees
   * the same writes, and the pages they lack load together. With `decode`, a
   * value is not copied: `decode` gets the bytes where they are stored and
   * returns what to keep, so it must neither change them nor keep them.
   */
  getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
  getMany<T>(keys: readonly Uint8Array[], decode: Decode<T>): Promise<(T | undefined)[]>;
  /** Resolves with the WAL seq of the record, as `batch` does. */
  put(key: Uint8Array, value: Uint8Array): Promise<number>;
  /** Resolves with the WAL seq of the record, as `batch` does. */
  delete(key: Uint8Array): Promise<number>;
  /**
   * `build` runs synchronously. Promise resolves after the shared IDB WAL
   * commit, with the record's seq. A batch with no ops writes nothing and
   * resolves with the seq this handle has applied through. Other tabs see
   * the write when its BroadcastChannel message arrives, a moment after the
   * ack, or after their next `sync()`.
   */
  batch(build: (tx: BatchTx) => void): Promise<number>;
  /**
   * Read `keys` and write as one step: `body` runs synchronously with the
   * values, in the order of `keys`, and its writes commit only if no other
   * write landed since they were read. So there is no conflict to handle,
   * and concurrent updates lose nothing. `body` usually runs once. It runs
   * again when another write landed between its read and its commit, when
   * it writes nothing or throws, and when the browser refuses the write for
   * lack of space: three times at most. Only its last run counts, so keep
   * it free of side effects. The updates of one handle run one at a time,
   * in call order.
   */
  update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T>;
  range(range?: Range): AsyncIterable<Entry>;
  /** How many entries `range` would yield, `limit` included, without copying them. */
  count(range?: Range): Promise<number>;
  /**
   * Read-only snapshot of every record through `snap.seq`.
   * Writes that commit during the callback are invisible to `snap`.
   */
  view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T>;
  /**
   * Subscribe to every WAL record this handle applies, with its ops, from
   * this tab and from other tabs, in seq order (`ChangeEvent`). Returns an
   * unsubscribe function.
   */
  changes(listener: ChangeListener): () => void;
  /**
   * Called when the browser refused a write and kv removed its reserve, or
   * could not write it back. Free about `full.need` bytes with ordinary
   * writes: deletes free space once a flush and a compaction hold them, and
   * the reserve is their room. Only the handle holding the Web Lock
   * `opfs-lsm-full/<name>` is called, and not again before a flush holds
   * what the handlers wrote. Returns unsubscribe.
   */
  onStorageFull(handler: (full: StorageFull) => Promise<void>): () => void;
  /**
   * Catch up to every write acked before the call, from any tab. Other tabs'
   * writes otherwise arrive over BroadcastChannel, a moment after their ack.
   */
  sync(): Promise<void>;
  close(): Promise<void>;
  /**
   * Delete every record of this database, in every tab. Seen from the log,
   * it is one write that deletes every key: writes acked before it are
   * gone, and writes after it land in the empty database. Every handle
   * stays open, and so does the storage; this one reads empty once it
   * resolves, other tabs at their next `sync`, and each reports a `gap`
   * change event. One IndexedDB transaction, on disk before the removes
   * start, empties the database. Then the host removes every run file no
   * tab still reads, and the rest once their tabs move on. Waits for a
   * flush or compaction step already running. `destroyDb` removes the
   * database instead, and closes every handle on it.
   */
  dangerousDestroy(): Promise<void>;
}

/** A page with SharedWorker also has Worker, which `openDb` starts where SharedWorker is missing. */
export function canUseBrowserOpfs(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/**
 * Every key that starts with the raw bytes `prefix`. For a prefix made by
 * `encodeTuple`, use `tupleBounds` from `@opfs-lsm/kv/tuple`. This one also
 * returns the keys where the prefix's last string goes on with U+0000.
 */
export function prefixBound(prefix: Uint8Array): {
  start: Uint8Array;
  endExclusive?: Uint8Array;
} {
  const start = checkKey(prefix);
  const end = successor(start);
  return end === undefined ? { start } : { start, endExclusive: end };
}

/** What `@opfs-lsm/kv/testing` reads from an open Db. */
type DbInternals = Pick<DbImpl, "name" | "wal" | "fs" | "ingestClient" | "flush">;

/** Undefined for a Db this package did not open. */
export function dbInternals(db: Db): DbInternals | undefined {
  return db instanceof DbImpl ? db : undefined;
}

export async function openDb(options: OpenOptions): Promise<Db> {
  return openOn(options, () => {
    // `opfs-lsm/` names no database, so its lookup runs while the lock is requested.
    const parent = canUseBrowserOpfs() ? openParent() : undefined;
    parent?.catch(() => undefined);
    return (name) => {
      if (!parent) throw new StorageUnavailableError(NEEDS_BROWSER);
      return {
        fs: openBrowserReadFs(name, parent),
        ingest: workerIngest(name),
        ownsIngestClient: true,
        writerId: newWriterId(),
        rowPostMs: ROW_POST_MS,
        maxWalBytes: DEFAULT_MAX_WAL_BYTES,
      };
    };
  });
}

export const NEEDS_BROWSER = "openDb needs a Worker and navigator.storage.getDirectory";

/**
 * A client of the package SharedWorker for `name`, or of a dedicated Worker
 * running the same script where there is no SharedWorker. The handle that
 * takes it closes it.
 */
function workerIngest(name: DbName): IngestClient {
  // The URL stays inline in the constructor: bundlers (Vite, webpack 5)
  // only emit a worker chunk for this exact shape. Built in a helper, Vite
  // treated it as a plain asset and inlined the unbundled entry as a
  // data: URL whose relative imports could not resolve.
  return createPortIngestClient(
    typeof SharedWorker === "undefined"
      ? new Worker(new URL("./host/shared-worker.js", import.meta.url), { type: "module", name: `opfs-lsm:${name}` })
      : new SharedWorker(new URL("./host/shared-worker.js", import.meta.url), { type: "module", name: `opfs-lsm:${name}` }).port,
  );
}

/**
 * Remove database `name`: every handle on it, in every tab and this one,
 * closes with a `closed` change event whose reason is "destroyed", then its
 * rows, its OPFS folder and its IndexedDB database go. It does not open the
 * database, so it also removes one that `openDb` refuses as corrupt. On a
 * name with nothing stored it creates nothing and starts no SharedWorker.
 * Once it resolves, no removed row comes back, even after a power loss.
 * Waits for a flush or compaction step already running, and for every
 * handle to close.
 */
export async function destroyDb(name: string): Promise<void> {
  return destroyDbWith({ name });
}

/** `destroyDb` on a given folder: with `fs`, that fs is the folder to remove. */
export async function destroyDbWith(options: { readonly name: string; readonly fs?: RemovableFolder | undefined }): Promise<void> {
  const name = checkDbName(options.name);
  const fs = options.fs;
  const opfs = typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
  if (typeof indexedDB === "undefined" || (!fs && !opfs)) {
    throw new StorageUnavailableError("destroyDb needs IndexedDB and navigator.storage.getDirectory");
  }
  await removeDatabase(name, fs ? async () => fs : () => findRemovableBrowserFs(name));
}

/**
 * The open path of `openDb` and `@opfs-lsm/kv/testing`. `prepare` runs once
 * the options are checked, before the open lock is requested, and the
 * function it returns builds the parts under the lock.
 */
export async function openOn(
  options: OpenOptions,
  prepare: () => (name: DbName) => OpenParts,
): Promise<Db> {
  const name = checkDbName(options.name);
  const reserveBytes = reserveOf(options.reserveBytes);
  // Started first, so the module loads while the rest of open runs.
  const engine = ensureEngine();
  // Awaited last: a throw before that must not leave its rejection unhandled.
  engine.catch(() => undefined);
  const caps = memtableCaps(options.memtableBytes);
  const connect = prepare();
  // Held until the open resolves, so `destroyDb` never meets a half-done open (design.md, "Removing").
  try {
    return await withLock(openLock(name), () => openStores(name, options, caps, reserveBytes, engine, connect(name)), "shared");
  } catch (cause) {
    // What is left raw is a browser API that is there and refused: OPFS, the SharedWorker or IndexedDB.
    if (!(cause instanceof DOMException)) throw cause;
    throw codeOfError(cause) === "quota" ? new StorageFullError("the origin's storage is full", { cause }) : unavailable("the browser's storage", cause);
  }
}

async function openStores(
  name: DbName,
  options: OpenOptions,
  caps: MemtableCaps,
  reserveBytes: number,
  engine: Promise<unknown>,
  parts: OpenParts,
): Promise<Db> {
  const { fs: tabFs, ingest, ownsIngestClient } = parts;
  // What the catch below closes: the Db once it exists, else the WAL and an owned port.
  let heldWal: TabWal | undefined;
  let heldDb: DbImpl | undefined;
  try {
    const wal = await TabWal.open(
      name,
      () => void heldDb?.closeFor("destroyed"),
      () => ingest.makeRoom(name),
    );
    heldWal = wal;
    // Pairs the WAL with a manifest before the first read or write resolves.
    // The recorded manifest's runs are checked by the load, which opens them.
    const recovering = reconcileOpen(wal, tabFs, () => ingest.repair(name));
    recovering.catch(() => undefined);
    const cacheBytes = options.cacheBytes ?? DEFAULT_BUDGET;
    // A comparison, not Math.max: NaN gets the minimum too.
    const cache = new PageCache(cacheBytes > MIN_MEMORY_BUDGET ? cacheBytes : MIN_MEMORY_BUDGET);
    const db = new DbImpl(
      name,
      parts.writerId,
      wal,
      tabFs,
      cache,
      ingest,
      ownsIngestClient,
      caps,
      parts.rowPostMs,
    );
    heldDb = db;
    await db.boot(recovering);
    // The host takes the smallest limit across tabs, so this tab's soft cap counts as one.
    db.watch({
      maxWalBytes: Math.min(parts.maxWalBytes, caps.soft),
      compactionMemoryBytes: compactionMemoryOf(options.compactionMemoryBytes),
      reserveBytes,
    });
    // The host cannot flush without the module, so a page that cannot load it does not open.
    await engine;
    return db;
  } catch (err) {
    if (heldDb) await heldDb.close();
    else {
      if (ownsIngestClient) ingest.close();
      heldWal?.close();
    }
    throw err;
  }
}

function collectBatch(
  build: (tx: BatchTx) => unknown,
): readonly CheckedOp[] {
  const batch = new CheckedBatch();
  let open = true;
  // A build that catches a check error still rejects the whole batch.
  let failure: { readonly error: unknown } | undefined;
  const add = (op: BatchOp) => {
    if (!open) throw new ConstraintError("tx used after its callback returned");
    try {
      batch.add(op);
    } catch (error) {
      failure ??= { error };
      throw error;
    }
  };
  let ret: unknown;
  try {
    ret = build({
      put: (key, value) => add({ type: "put", key, value }),
      delete: (key) => add({ type: "del", key }),
      deleteRange: (bounds, options) =>
        add({ type: "deleteRange", start: bounds.start, endExclusive: bounds.endExclusive, through: options?.through }),
    });
  } finally {
    open = false;
  }
  if (typeof (ret as { then?: unknown } | undefined)?.then === "function") {
    throw new ConstraintError("callback must not return a thenable");
  }
  if (failure) throw failure.error;
  return batch.ops;
}

/** An open run file and the number of `Layers` that list it. */
type Run = {
  readonly path: string;
  readonly file: OpenFile;
  readonly reader: SstReader;
  layers: number;
};

/**
 * One generation's runs. `refs` counts its holders: the `installed` and
 * `loaded` slots, each open view, and each live `range()` iterator. The
 * last release lets go of its runs, so the host may delete their files.
 */
type Layers = {
  readonly generation: Generation;
  readonly runs: readonly Run[];
  /** The readers as scan sources, newest first. */
  readonly levels: readonly RunLevel[];
  /** The manifest's marks: the range deletes its runs may still hold covered versions for. */
  readonly marks: Marks;
  refs: number;
};

/** Runs opened at once while loading a generation. */
const OPEN_CONCURRENCY = 16;

/**
 * A row that lands within this long of the tab's last post waits, and one
 * message carries the rows of the wait (design.md, "Seeing other tabs'
 * writes"). The cost of a post is per message, and a tab that awaits each
 * put lands many rows in this time.
 */
export const ROW_POST_MS = 4;

/** A page nobody looks at. The browser slows its timers, and can stop them. */
function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Tries under the reclaim lock: each failure means files really are gone. */
const GENERATION_RETRIES = 8;
/** Why a catch-up or write attempt must run again: "behind" when another load installed a newer generation, "gone" when a file of the tail's generation is missing. */
type Retry = "behind" | "gone";

function finished<T>(step: T | Retry): step is T {
  return step !== "behind" && step !== "gone";
}
const GENERATION_GONE =
  "SST files for the recorded generation stayed missing after retries";

/**
 * Reads come from this tab's memtable over the installed SST generation and
 * touch no IndexedDB. The memtable is always an exact WAL prefix, and the
 * installed generation never holds seqs past it, so every read sees the
 * state after one WAL prefix. Other tabs' writes arrive over BroadcastChannel.
 */
class DbImpl implements Db {
  private closed = false;
  private readonly mem = new Memtable();
  private installed: Layers = {
    generation: GENERATION_NONE,
    runs: [],
    levels: [],
    marks: NO_MARKS,
    refs: 1,
  };
  /** The newest generation loaded and not yet installed. */
  private loaded: Layers | undefined = undefined;
  /** Open runs of every held generation by path. Paths are immutable, so a hit never goes stale. */
  private readonly runs = new Map<string, Run>();
  private readonly catchUpToWal = coalesced(() => this.syncOnce());
  private readonly listeners = new Set<ChangeListener>();
  /** Applied and not yet announced, in seq order. Drained outside IndexedDB callbacks. */
  private unannounced: ChangeEvent[] = [];
  private announcing = false;
  /** A repair may have recorded another manifest, so the next install can change what reads return. */
  private repaired = false;
  private readonly bus: BroadcastChannel | undefined;
  /** Landed and not yet posted, in seq order, with the bytes of their ops. */
  private unposted: BusRow[] = [];
  private unpostedBytes = 0;
  /** `performance.now()` of the last post. */
  private postedAt = Number.NEGATIVE_INFINITY;
  /** Posts the rows that no later landing posted. */
  private postTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Posts the rows that wait when the page is hidden, before the browser slows the timer. */
  private readonly onVisibility = () => this.postRows();
  private readonly pressure: Backpressure;
  /** The last read point and the two tables it joined. */
  private lastPoint: { readonly installed: Marks; readonly mem: Marks; readonly at: Marks } | undefined;
  private readonly handlers = new Set<StorageFullHandler>();
  /** Lets go of the full lock, or of the wait for it. Set while this handle has a handler. */
  private unlock: (() => void) | undefined;
  private holding = false;
  private answering = false;
  /** This handle has said once that no tab has a handler. */
  private warned = false;
  /** Appends of this handle that have not joined the memtable yet. A read now would miss them. */
  private appending = 0;
  /** The last `update` of this handle. Each waits for the one before it. */
  private updating: Promise<unknown> = Promise.resolve();
  /** A row of an `update` of this handle lost its seq, and no transaction of one has found the tail empty since. */
  private beaten = false;
  /** The host counts this handle among its watchers. An open that failed or closed before `watch` must not take another tab's place. */
  private watched = false;

  constructor(
    readonly name: DbName,
    readonly writerId: WriterId,
    readonly wal: TabWal,
    readonly fs: ReadFs,
    private readonly cache: PageCache,
    readonly ingestClient: IngestClient,
    private readonly ownsIngestClient: boolean,
    caps: MemtableCaps,
    private readonly rowPostMs: number,
  ) {
    this.pressure = new Backpressure(
      caps,
      () => this.mem.bytes,
      () => this.relieve(),
    );
    if (typeof BroadcastChannel !== "undefined") {
      this.bus = new BroadcastChannel(layersChannel(name));
      this.bus.addEventListener("message", (ev: MessageEvent<BusMessage>) => this.onMessage(ev.data));
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", this.onVisibility);
      }
    }
  }

  private onMessage(data: BusMessage): void {
    if (this.closed) return;
    if (data?.kind === "rows" && Array.isArray(data.rows)) {
      if (data.writerId === this.writerId) return;
      for (const row of data.rows) {
        // The catch-up reads the rest of the message's rows too.
        if (this.applyRecord({ seq: row.seq, ops: decodeOps(row.record, row.seq) }) === "gap") {
          void this.sync().catch(() => undefined);
          break;
        }
      }
      return this.announce();
    }
    if (data?.kind === "full") return void this.answer(data.full).catch(() => undefined);
    if (data?.kind === "full-pull" || data?.kind === "full-done") return;
    // An `ingest`, or a message this build does not know: catch up from the WAL.
    void this.sync().catch(() => undefined);
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("database is closed");
  }

  /**
   * Tell the other tabs and the host about a row this tab appended. Posted
   * at once unless the tab posted within the last `rowPostMs`: then it
   * waits for the first landing past that time, or for the timer when no
   * landing follows. A hidden page posts every row at once.
   */
  private broadcast(row: BusRow, bytes: number): void {
    if (this.closed || !this.bus) return;
    this.unposted.push(row);
    this.unpostedBytes += bytes;
    if (pageHidden() || performance.now() - this.postedAt >= this.rowPostMs) this.postRows();
    else this.postTimer ??= setTimeout(() => this.postRows(), this.rowPostMs);
  }

  private postRows(): void {
    clearTimeout(this.postTimer);
    this.postTimer = undefined;
    if (this.unposted.length === 0) return;
    const message: BusMessage = {
      kind: "rows",
      writerId: this.writerId,
      rows: this.unposted,
      bytes: this.unpostedBytes,
    };
    this.unposted = [];
    this.unpostedBytes = 0;
    this.postedAt = performance.now();
    this.bus?.postMessage(message);
  }

  /** The one place a record joins the memtable. */
  private applyRecord(record: WalRecord): "applied" | "already" | "gap" {
    const applied = this.mem.apply(record);
    if (applied === "applied") {
      this.unannounced.push({ kind: "append", seq: record.seq, ops: record.ops });
    }
    return applied;
  }

  /** The one place the memtable drops rows an installed generation covers. */
  private advance(through: Seq): void {
    if (this.mem.advanceTo(through) || this.repaired) {
      this.repaired = false;
      this.unannounced.push({ kind: "gap", through: this.mem.appliedThrough });
    }
  }

  /**
   * A listener that closes the handle calls this again. That call returns,
   * and the loop already running delivers `closed` once every listener has
   * the events before it.
   */
  private announce(): void {
    if (this.announcing) return;
    this.announcing = true;
    try {
      for (let events = this.unannounced; events.length > 0; events = this.unannounced) {
        this.unannounced = [];
        for (const event of events) {
          for (const listener of this.listeners) {
            try {
              listener(event);
            } catch (err) {
              console.error("changes() listener threw", err);
            }
          }
          if (event.kind === "closed") this.listeners.clear();
        }
      }
    } finally {
      this.announcing = false;
    }
  }

  private emit(event: ChangeEvent): void {
    this.unannounced.push(event);
    this.announce();
  }

  /**
   * True when `generation` needs no load. Generations grow, so one below
   * the installed or loaded one is stale, unless the tail that names it is
   * `ahead` of the memtable (see `catchUp`).
   */
  private has(generation: Generation, ahead: boolean): boolean {
    return [this.installed, this.loaded].some(
      (layers) =>
        layers !== undefined &&
        (layers.generation === generation || (layers.generation > generation && !ahead)),
    );
  }

  /**
   * Make `generation` the loaded one, opening its runs when needed. `ahead`
   * says its tail holds seqs past the memtable, and `copy` is the manifest
   * head that tail read. It names the runs, so they open while the manifest
   * file is read. The file is read either way: it holds the block indexes,
   * and a power loss can keep the copy and lose the file with its runs.
   * False when its manifest or one of its runs is gone.
   */
  private async load(generation: Generation, ahead: boolean, copy?: Uint8Array): Promise<boolean> {
    if (this.has(generation, ahead)) return true;
    const manifest = loadGeneration(this.fs, generation);
    const paths = runsOfCopy(copy, generation) ?? (await manifest)?.runs.map((r) => r.path);
    if (!paths) return false;
    const runs: (Run | undefined)[] = [];
    let next = 0;
    let gone = false;
    const openNext = async (): Promise<void> => {
      while (next < paths.length && !gone) {
        const i = next++;
        runs[i] = await this.openRun(paths[i]!, i, manifest);
        if (!runs[i]) gone = true;
      }
    };
    const settled = await Promise.allSettled([
      manifest,
      ...Array.from({ length: Math.min(OPEN_CONCURRENCY, paths.length) }, openNext),
    ]);
    const held = runs.filter((r) => r !== undefined);
    const failed = settled.find((r) => r.status === "rejected");
    const meta = failed ? undefined : await manifest;
    if (failed || gone || !meta || this.closed || this.has(generation, ahead)) {
      this.dropRuns(held);
      if (failed) throw failed.reason;
      return !gone && !!meta;
    }
    if (this.loaded) this.release(this.loaded);
    this.loaded = {
      generation,
      runs: held,
      levels: runLevels(paths, held.map((r) => r.reader)),
      marks: meta.marks,
      refs: 1,
    };
    return true;
  }

  /**
   * The open run at `path`, run `i` of `manifest`, counted for one more
   * `Layers`. Undefined when the file or the manifest is gone, which the
   * generation retries handle. Reads no run bytes: the reader loads its
   * blocks and its Bloom filter on first use.
   */
  private async openRun(path: string, i: number, manifest: Promise<GenerationMeta | undefined>): Promise<Run | undefined> {
    let run = this.runs.get(path);
    if (!run) {
      const file = await this.fs.open(path);
      if (!file) return undefined;
      // A manifest that does not decode fails the load, which awaits it too.
      const meta = (await manifest.catch(() => undefined))?.runs[i];
      run = this.runs.get(path);
      if (run || !meta) file.close();
      else this.runs.set(path, (run = { path, file, reader: new SstReader(file, this.cache, meta, meta.marksThrough), layers: 0 }));
      if (!run) return undefined;
    }
    run.layers += 1;
    return run;
  }

  private retain(layers: Layers): void {
    layers.refs += 1;
  }

  private release(layers: Layers): void {
    if (--layers.refs === 0) this.dropRuns(layers.runs);
  }

  private dropRuns(runs: readonly Run[]): void {
    for (const run of runs) {
      if (--run.layers > 0) continue;
      this.runs.delete(run.path);
      run.reader.close();
      run.file.close();
    }
  }

  /** True when `tail` was read before the installed generation was recorded. */
  private old(tail: WalTail): boolean {
    return tail.ingestedThrough < this.mem.ingestedThrough;
  }

  /**
   * Apply `tail` to the memtable. Synchronous, so it can run inside an
   * IndexedDB transaction. Returns the generation to load when the tail
   * needs one this tab does not have yet.
   */
  private catchUp(tail: WalTail): Generation | undefined {
    const behind = tail.ingestedThrough > this.mem.appliedThrough;
    const layers = this.loaded?.generation === tail.generation ? this.loaded : undefined;
    // A tail read before the installed generation was recorded names a
    // stale generation and ingestedThrough. It is never ahead of the
    // memtable, which caught up to the installed one, and when it is `old`
    // its generation can be the higher one: a destroy or a repair recorded
    // a lower generation past its seqs. A tail that is ahead and names a
    // lower generation comes after one of those (design.md, "Recovery"),
    // so this tab follows it.
    if (
      (tail.generation > this.installed.generation && !this.old(tail)) ||
      (behind && tail.generation < this.installed.generation)
    ) {
      if (layers) {
        this.release(this.installed);
        this.installed = layers;
        this.loaded = undefined;
      } else if (behind) {
        return tail.generation;
      }
    }
    if (this.loaded && (this.loaded.generation <= this.installed.generation || this.loaded === layers)) {
      this.release(this.loaded);
      this.loaded = undefined;
    }
    if (this.installed.generation === tail.generation) {
      this.advance(tail.ingestedThrough);
    }
    for (const record of tail.records) {
      if (this.applyRecord(record) === "gap") {
        throw new CommitError(`wal gap before seq ${record.seq}`);
      }
    }
    return undefined;
  }

  /**
   * Catch up to everything acked before the call, and install the current
   * generation. Reads after it resolves see other tabs' acked writes.
   */
  async sync(): Promise<void> {
    this.ensureOpen();
    return this.catchUpToWal();
  }

  private async syncOnce(): Promise<void> {
    await this.retrying(() => this.catchUpOnce());
  }

  /**
   * Run `attempt` once without the reclaim lock, the usual path. A run or
   * manifest that went missing mid-load was almost always reclaimed after
   * a newer generation replaced it, and under churn that can repeat on
   * every try. So the retries hold the reclaim lock shared: the host
   * removes no file until they return, and the generation a retry reads
   * keeps every file (design.md, "Loading a generation under churn").
   * Nothing the host does removes a file while the lock is held, so a
   * retry that finds one "gone" repairs, and gives up after
   * `GENERATION_RETRIES`.
   */
  private async retrying<T>(attempt: () => Promise<T | Retry>): Promise<T> {
    const first = await attempt();
    if (finished(first)) return first;
    return holdingFiles(this.name, async () => {
      for (let gone = 0; ; ) {
        const step = await attempt();
        if (finished(step)) return step;
        if (step === "gone") {
          if (++gone >= GENERATION_RETRIES) throw new CorruptDatabaseError(GENERATION_GONE);
          await this.repair();
        }
      }
    });
  }

  /** Read the tail and catch up to it. After close the connection is gone, and as in `follow` there is nothing to catch up. */
  private catchUpOnce(): Promise<"done" | Retry> {
    if (this.closed) return Promise.resolve("done");
    return this.wal.tail(this.mem.appliedThrough, this.installed.generation).then((tail) => this.follow(tail));
  }

  /**
   * The open's catch-up. The tail is read and its generation loaded while
   * recovery checks, and the tail applies when recovery wrote nothing.
   * Otherwise the tail is not one any more, and a sync reads again.
   */
  async boot(recovering: Promise<boolean>): Promise<void> {
    // The runs open while the records are read. The read settles once the
    // load has, so no load installs its generation after the fallback below.
    let loading: Promise<boolean> | undefined;
    const reading = this.wal
      .tail(SEQ_ZERO, GENERATION_NONE, (generation, ingestedThrough, manifest) => {
        loading = Promise.resolve(manifest).then((copy) => this.load(generation, ingestedThrough > SEQ_ZERO, copy));
        loading.catch(() => undefined);
      })
      .finally(() => loading);
    const [kept, tail] = await Promise.all([recovering, reading.catch(() => undefined)]);
    if (tail && kept && (await this.follow(tail)) === "done") return;
    if (this.loaded) this.release(this.loaded);
    this.loaded = undefined;
    await this.sync();
  }

  /**
   * Catch up to `tail`. "behind" when another load installed a newer
   * generation meanwhile, "gone" when the tail's generation lacks a file.
   */
  private async follow(tail: WalTail): Promise<"done" | Retry> {
    if (this.closed) return "done";
    let whole = true;
    if (tail.generation !== this.installed.generation && !this.old(tail)) {
      const ahead = tail.ingestedThrough > this.mem.appliedThrough;
      whole = await this.load(tail.generation, ahead, tail.manifest);
      if (this.closed) return "done";
    }
    let missing: number | undefined;
    try {
      missing = this.catchUp(tail);
    } finally {
      this.announce();
    }
    if (missing === undefined) return "done";
    return whole ? "behind" : "gone";
  }

  /**
   * The recorded generation did not load. Usually a newer one replaced it
   * and the next tail names that one. After a power loss its manifest or
   * runs can be gone for good: the host's `reconcile` then records one
   * that pairs with the WAL (design.md, "Recovery"). It changes nothing
   * while IndexedDB names a generation other than the one found broken.
   */
  private async repair(): Promise<void> {
    await this.ingestClient.repair(this.name);
    this.repaired = true;
  }

  /**
   * Join this tab's committed record to the memtable and announce it before
   * the ack resolves. A gap means another tab appended first: catch up,
   * which reads the record too. A row with no ops lost its seq, and the
   * transaction `write` runs next reads the tail, so it waits for no catch-up.
   */
  private async landed(seq: Seq, ops: readonly CheckedOp[], record: ArrayBuffer): Promise<void> {
    if (this.applyRecord({ seq, ops: resolveOps(ops, seq) }) === "gap" && ops.length && !this.closed) await this.sync();
    this.pressure.landed();
    this.announce();
    this.broadcast({ seq, record }, flushBytes(ops));
  }

  /** One flush for the backpressure gate. True when it moved this tab to a newer generation. */
  private async relieve(): Promise<boolean> {
    const before = this.installed.generation;
    await this.flush(false);
    return this.installed.generation > before;
  }

  /**
   * In one readwrite transaction, catch the memtable up, let `plan` choose a
   * batch against it, and append. The batch joins the memtable at its seq,
   * so this tab reads its own write as soon as the ack resolves. Awaiting
   * inside the transaction would commit it, so `warm` loads what `plan`
   * reads before each attempt, and a `plan` that still misses appends
   * nothing and is retried. A tail that names a generation this tab lacks
   * appends nothing either: the tab loads it and tries again (`retrying`).
   * It first waits out a full memtable (`Backpressure.admit`). Resolves with the
   * appended seq, undefined when `plan` chose no ops, and `plan`'s result.
   */
  private async write<R>(
    plan: () => Maybe<{ readonly ops: readonly CheckedOp[]; readonly result: R }>,
    warm?: () => Promise<unknown>,
  ): Promise<{ readonly seq: Seq | undefined; readonly result: R }> {
    // Only its turn: the handle is checked open again below.
    await this.pressure.admit();
    const out = await this.retrying(async () => {
      for (;;) {
        await warm?.();
        this.ensureOpen();
        let missing: Generation | undefined;
        let miss: Miss | undefined;
        const appended = await this.wal
          .appendAfter(this.mem.appliedThrough, (tail) => {
            missing = this.catchUp(tail);
            if (missing !== undefined) return undefined;
            const planned = plan();
            if (!(planned instanceof Miss)) return planned;
            miss = planned;
            return undefined;
          })
          .finally(() => this.announce());
        if (appended) return appended;
        if (missing !== undefined) return (await this.load(missing, true)) ? "behind" : "gone";
        // The next warm reads again and surfaces a real failure.
        await miss?.ready.catch(() => undefined);
      }
    });
    if (out.seq !== undefined) await this.landed(out.seq, out.ops, out.record);
    return out;
  }

  /**
   * Runs `attempt` over the installed levels until it stops missing. While
   * it waits it holds those levels, so a generation installed meanwhile
   * cannot let the host delete the files it is reading.
   */
  private async settleInstalled<T>(
    attempt: (levels: readonly RunLevel[]) => Maybe<T>,
    held?: ReadSet,
  ): Promise<T> {
    const layers = this.installed;
    const read = () => attempt(layers.levels);
    const first = held ? held.attempt(read) : read();
    if (!(first instanceof Miss)) return first;
    this.retain(layers);
    try {
      return await (held ?? new ReadSet()).settle(read, first);
    } catch (err) {
      this.ensureOpen();
      throw err;
    } finally {
      this.release(layers);
    }
  }

  /**
   * What an operation judges rows against: the installed marks joined with
   * the memtable's. Take it in the turn that captures the installed levels,
   * and keep it for the whole operation.
   */
  private point(): Marks {
    const installed = this.installed.marks;
    const mem = this.mem.marks;
    const last = this.lastPoint;
    if (last?.installed === installed && last.mem === mem) return last.at;
    const at = mem.length > 0 ? [...installed, ...mem] : installed;
    this.lastPoint = { installed, mem, at };
    return at;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    const row = this.mem.get(k);
    const at = this.point();
    return this.settleInstalled((levels) => pointGet(row, levels, k, at));
  }

  async getMany<T>(keys: readonly Uint8Array[], decode?: Decode<T>): Promise<(T | undefined)[]> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    // With the levels `settleInstalled` holds, these rows are one state of the store, whatever lands while a page loads.
    const mems = this.memRows(ks);
    const at = this.point();
    return this.settleInstalled(keysReader(mems, ks, at, decode));
  }

  private memRows(keys: readonly Uint8Array[]): (MemRow | undefined)[] {
    return keys.map((k) => this.mem.get(k));
  }

  put(key: Uint8Array, value: Uint8Array): Promise<number> {
    return this.batch((tx) => tx.put(key, value));
  }

  delete(key: Uint8Array): Promise<number> {
    return this.batch((tx) => tx.delete(key));
  }

  async batch(build: (tx: BatchTx) => void): Promise<number> {
    this.ensureOpen();
    const ops = collectBatch(build);
    if (ops.length === 0) return this.mem.appliedThrough;
    // After a close that came while it waited its turn, the append rejects with ClosedError.
    return this.pressure.admit(() => this.commit(ops));
  }

  /**
   * Append `ops` by group commit and land the row. With `validAt`, the row
   * has its ops at that seq alone (`rowValid`): at any other it lands with
   * none, here as in every other reader.
   */
  private async commit(ops: readonly CheckedOp[], validAt?: Seq): Promise<Seq> {
    const record = encodeOps(ops, validAt);
    this.appending++;
    try {
      const seq = await this.wal.append(record);
      await this.landed(seq, rowValid(validAt, seq) ? ops : [], record);
      return seq;
    } finally {
      this.appending--;
    }
  }

  async update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    const turn = this.updating.then(() => this.updateOnce(ks, body));
    this.updating = turn.catch(() => undefined);
    return turn;
  }

  /**
   * One `update`, with no other of this handle running. It reads the
   * memtable, runs `body`, and appends a row that is valid only at
   * `appliedThrough + 1`, by group commit: one round trip. The row takes
   * that seq exactly when no other write committed since the read, so then
   * `body` saw the state just before its own write. Otherwise the row has no
   * ops, and `write` runs `body` again inside a transaction, which cannot
   * lose. `write` runs it alone when an append of this handle is in flight,
   * whose row the memtable lacks, or when a read still waits for a page, and
   * again when `body` wrote nothing or threw, so that what it returns or
   * throws was read at the committed head. It also runs it alone after a row
   * lost (`beaten`): while another tab keeps writing, every row would lose,
   * and cost a round trip more than the transaction alone.
   */
  private async updateOnce<T>(
    ks: readonly CheckedKey[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    // One set for the warm reads and the reads that cannot wait for a load.
    const held = new ReadSet();
    const read = () => keysReader(this.memRows(ks), ks, this.point());
    /** What the last `warm` read, and the `appliedThrough` it read at. */
    let warmed: [Seq, (Uint8Array | undefined)[]] | undefined;
    const plan = () => {
      // Nothing landed since the warm read, so it read this state: no second read.
      const values =
        warmed?.[0] === this.mem.appliedThrough ? warmed[1] : held.attempt(() => read()(this.installed.levels));
      warmed = undefined;
      if (values instanceof Miss) return held.keep(values);
      let result!: T;
      const ops = collectBatch((tx) => {
        result = body(values, tx);
        return result;
      });
      return { ops, result };
    };
    const warm = async () => {
      // The rows, levels and marks it reads are all taken now, so the values are the state at `at`.
      const at = this.mem.appliedThrough;
      warmed = [at, await this.settleInstalled(read(), held)];
    };
    // Only its turn: the handle is checked open again below.
    await this.pressure.admit();
    await warm();
    this.ensureOpen();
    // No await from here to the append: the seq the row is valid at and the state `body` reads are one instant.
    const next = nextSeq(this.mem.appliedThrough);
    if (!this.appending && !this.beaten) {
      let planned: ReturnType<typeof plan> | undefined;
      try {
        planned = plan();
      } catch {
        // This handle can lag another tab's write: the run in `write`, at the head, throws for good.
      }
      // `write` loads what missed again and surfaces a failure, so the one of this load is dropped.
      if (planned instanceof Miss) planned.ready.catch(() => undefined);
      else if (planned?.ops.length) {
        if (rowValid(next, await this.commit(planned.ops, next))) return planned.result;
        this.beaten = true;
      }
    }
    const out = await this.write(plan, warm);
    // The transaction took the seq this update started at: no other write is in the way.
    if (out.seq === next) this.beaten = false;
    return out.result;
  }

  async count(range?: Range): Promise<number> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const layers = this.installed;
    const at = this.point();
    this.retain(layers);
    try {
      return await countOf(scanStep(this.mem.range(bounds), layers.levels, at, bounds, range));
    } catch (err) {
      this.ensureOpen();
      throw err;
    } finally {
      this.release(layers);
    }
  }

  range(range?: Range): AsyncIterable<Entry> {
    return rangeScan({
      start: () => {
        this.ensureOpen();
        const bounds = boundsOf(range);
        const layers = this.installed;
        const step = scanStep(this.mem.range(bounds), layers.levels, this.point(), bounds, range);
        this.retain(layers);
        return { step, release: () => this.release(layers) };
      },
      check: () => this.ensureOpen(),
      failed: () => this.ensureOpen(),
    });
  }

  async view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const layers = this.installed;
    this.retain(layers);
    const snap = new ViewSnapshotImpl(
      this.mem.appliedThrough,
      this.mem.pin(),
      layers.levels,
      this.point(),
      () => {
        this.retain(layers);
        return () => this.release(layers);
      },
      () => this.ensureOpen(),
    );
    try {
      return await body(snap);
    } finally {
      snap.close();
      this.release(layers);
    }
  }

  changes(listener: ChangeListener): () => void {
    this.ensureOpen();
    // A function of its own per call, so two subscriptions of one function end apart.
    const own: ChangeListener = (event) => listener(event);
    this.listeners.add(own);
    return () => {
      this.listeners.delete(own);
    };
  }

  onStorageFull(handler: StorageFullHandler): () => void {
    this.ensureOpen();
    const own: StorageFullHandler = (full) => handler(full);
    this.handlers.add(own);
    if (!this.unlock) this.askLock();
    return () => {
      if (this.handlers.delete(own) && this.handlers.size === 0) this.unlock?.();
    };
  }

  private askLock(): void {
    const abort = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const unlock = (this.unlock = () => {
      this.unlock = undefined;
      this.holding = false;
      abort.abort();
      release();
    });
    webLocks()
      ?.request(fullLock(this.name), { signal: abort.signal }, () => {
        // Granted before `unlock` could abort the request: `held` is settled, so the lock goes back.
        if (this.unlock !== unlock) return held;
        this.holding = true;
        this.bus?.postMessage({ kind: "full-pull" } satisfies BusMessage);
        return held;
      })
      .catch(() => undefined);
  }

  /**
   * Answer an offer. The holder of the full lock runs its handlers. A
   * handle with no handler answers when no handle holds the lock, so the
   * host tries the reserve again once space is free.
   */
  private async answer(full: StorageFull): Promise<void> {
    if (this.holding && !this.answering) {
      this.answering = true;
      for (const handler of [...this.handlers]) {
        try {
          await handler(full);
        } catch (err) {
          console.error(`opfs-lsm: an onStorageFull handler of ${this.name} failed`, err);
        }
      }
      this.answering = false;
      // A handle that let go of the lock meanwhile stays silent, so the next holder pulls the offer.
      if (this.holding) this.bus?.postMessage({ kind: "full-done" } satisfies BusMessage);
    } else if (this.handlers.size === 0) {
      const free = await webLocks()?.request(
        fullLock(this.name),
        { mode: "shared", ifAvailable: true },
        (lock) => lock !== null,
      );
      if (!free || this.closed) return;
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `opfs-lsm: the browser refused a write to ${this.name}, and no tab has an onStorageFull handler to free ${full.need} bytes`,
        );
      }
      this.bus?.postMessage({ kind: "full-done" } satisfies BusMessage);
    }
  }

  watch(policy: WatchPolicy): void {
    // A handle the browser closed while it loaded has already run its close.
    if (this.closed) return;
    this.ingestClient.watch(this.name, policy);
    this.watched = true;
  }

  /** Have the host flush the WAL, and load what it published. */
  async flush(waitForCompaction: boolean): Promise<{ generation: number }> {
    this.ensureOpen();
    const result = await this.ingestClient.ingest(this.name, waitForCompaction);
    await this.sync();
    return result;
  }

  async dangerousDestroy(): Promise<void> {
    this.ensureOpen();
    await this.ingestClient.destroy(this.name);
    // Moving to the empty generation lets go of this tab's runs, and the
    // ingest reclaims them.
    await this.sync();
    await this.ingestClient.ingest(this.name, true);
  }

  close(): Promise<void> {
    return this.closeFor("close");
  }

  /**
   * Close the handle, with `reason` in its `closed` event. "destroyed": the
   * WAL connection was asked to close, by `destroyDb`'s fence or by the
   * browser deleting the database. A read that fails afterwards rejects
   * with `ClosedError`: the files may be gone.
   */
  async closeFor(reason: "close" | "destroyed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit({ kind: "closed", reason });
    this.unlock?.();
    if (this.bus) {
      this.postRows();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.onVisibility);
      }
      this.bus.close();
    }
    if (this.watched) this.ingestClient.unwatch(this.name);
    if (this.ownsIngestClient) this.ingestClient.close();
    this.wal.close();
    this.release(this.installed);
    if (this.loaded) this.release(this.loaded);
    this.loaded = undefined;
  }
}
