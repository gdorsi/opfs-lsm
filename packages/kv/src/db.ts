import { Backpressure, memtableCaps, type MemtableCaps } from "./backpressure.js";
import { successor } from "./bytes.js";
import {
  checkBatch,
  checkDbName,
  checkKey,
  newWriterId,
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
  StorageUnavailableError,
} from "./errors.js";
import { DEFAULT_COMPACTION_MEMORY_BYTES } from "./host/budget.js";
import {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
  type WatchScan,
} from "./host/engine-host.js";
import { holdingFiles, layersChannel, type IngestClient } from "./host/protocol.js";
import { IdBWal, type WalReadProfile, type WalTail } from "./idb/wal.js";
import { reconcile } from "./recover.js";
import { Memtable, type MemRow, type WalRecord } from "./store/memtable.js";
import { allMissed, Miss, settle, type Maybe } from "./store/cursor.js";
import { DEFAULT_INGEST_POLICY, type IngestPolicy } from "./ingest-policy.js";
import type { AsyncFs, OpenFile } from "./opfs/async-fs.js";
import { CountingFs } from "./opfs/counting-fs.js";
import { openBrowserFs } from "./opfs/browser-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";
import {
  loadGeneration,
  type RunMeta,
} from "./store/generation.js";
import { pointGetSst, runLevels, type RunLevel } from "./store/merge.js";
import { ensureEngine } from "./store/engine.js";
import { DEFAULT_BUDGET, PageCache } from "./store/page-cache.js";
import { SstReader } from "./store/sst-reader.js";
import {
  ViewSnapshotImpl,
  boundsOf,
  scanLayers,
  type ViewSnapshot,
} from "./view.js";
import {
  ChangeBus,
  type ChangeEvent,
  type ChangeListener,
} from "./changes.js";

export type { ViewSnapshot } from "./view.js";
export type { ChangeEvent, ChangeListener, ChangeKind, ChangeOp } from "./changes.js";

/** Public open options. Apps pass a database name; the library owns the rest. */
export type OpenOptions = {
  readonly name: string;
  /**
   * Bytes of run files this tab keeps in memory: cached data pages plus
   * each run's Bloom filter and block index. Default 256 MiB, at least
   * 1 MiB. It does not cover the memtable, the wasm heap, or values handed
   * to the caller. Each `openDb` has its own budget.
   */
  readonly memoryBudget?: number;
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
};

/** Below this, one page per merge source may not fit. */
const MIN_MEMORY_BUDGET = 1024 * 1024;

/**
 * Harness / test open options (`openHarnessDb` in `@opfs-lsm/kv/testing`).
 * Not part of the app-facing API.
 */
export type HarnessOpenOptions = OpenOptions & {
  /**
   * SST/generation filesystem used for reads on this tab.
   * Must match what the ingest host publishes to.
   * Omit in the browser to use OPFS. Omit in Node to use MemoryFs.
   */
  readonly fs?: AsyncFs;
  /**
   * Ingest client. Omit in the browser for the package SharedWorker.
   * Omit in Node/tests for an in-process EngineHost.
   */
  readonly ingest?: IngestClient;
  /** Stable writer id (tests / debugging). Default: random UUID. */
  readonly writerId?: string;
  /** When the ingest host flushes the WAL to an OPFS run. */
  readonly ingestPolicy?: Partial<IngestPolicy>;
  /**
   * Force the Node/test path (MemoryFs + local host) even in a browser.
   */
  readonly forceMemory?: boolean;
  /**
   * Use MemoryFs when this page has no SharedWorker or OPFS.
   * Data lives only until the page closes. Ignored when OPFS can open,
   * and ignored in Node, which already defaults to MemoryFs.
   */
  readonly allowEphemeral?: boolean;
  /**
   * When set, open records phase durations here. The host scan and wasm
   * init can append after the open promise resolves.
   */
  readonly trace?: OpenTrace;
};

/** One timed piece of open. `endedAt` is `performance.now()` on this thread. */
export type OpenSpan = {
  phase: string;
  ms: number;
  rows?: number;
  bytes?: number;
  endedAt: number;
};

export type OpenTrace = {
  spans: OpenSpan[];
};

function span(
  trace: OpenTrace | undefined,
  phase: string,
  ms: number,
  extra?: { rows?: number; bytes?: number },
): void {
  if (!trace) return;
  trace.spans.push({ phase, ms, endedAt: performance.now(), ...extra });
}

function recordWatchScan(trace: OpenTrace, scan: WatchScan): void {
  span(trace, "host-scan", scan.ms, { rows: scan.rows, bytes: scan.bytes });
}

export type Range = {
  /** Inclusive. Bounds are in key order whichever way `reverse` points. */
  readonly start?: Uint8Array;
  /** Exclusive. */
  readonly endExclusive?: Uint8Array;
  /** At most this many entries, taken in scan order, so the largest keys with `reverse`. */
  readonly limit?: number;
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

export type Entry = { readonly key: Uint8Array; readonly value: Uint8Array };

export interface BatchTx {
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
}

export interface Db {
  /** The name passed to `openDb`. */
  readonly name: string;
  readonly writerId: WriterId;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /** Resolves with the WAL seq of the record, as `batch` does. */
  put(key: Uint8Array, value: Uint8Array): Promise<number>;
  /** Resolves with the WAL seq of the record, as `batch` does. */
  delete(key: Uint8Array): Promise<number>;
  /**
   * `build` runs synchronously. Promise resolves after the shared IDB WAL
   * commit, with the record's seq. A batch with no ops writes nothing and
   * resolves with the seq this handle has applied through. Other tabs see
   * the write when its BroadcastChannel message arrives, a moment after the
   * ack, or after their next `sync()`. The ingest host flushes the WAL to
   * OPFS per ingestPolicy.
   */
  batch(build: (tx: BatchTx) => void): Promise<number>;
  /**
   * Read `keys` and write, in one IndexedDB transaction. `body` runs
   * synchronously with the current values, in the order of `keys`. No other
   * write can land between the reads and the commit, so there is no conflict.
   */
  update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T>;
  /**
   * Scan `range`, then point-read `follow(entry)` for each entry that returns a
   * key. The scan and the reads use one pinned memtable and one held
   * generation, so they see the same state although a page load can make them
   * wait. Writes that land meanwhile are not seen.
   */
  rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]>;
  range(range?: Range): AsyncIterable<Entry>;
  /**
   * Read-only snapshot: pinned WAL head + OPFS generation at open.
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
   * Catch up to every write acked before the call, from any tab. Other tabs'
   * writes otherwise arrive over BroadcastChannel, a moment after their ack.
   */
  sync(): Promise<void>;
  /** Flush the memtable now and wait for the compaction it starts. */
  ingest(): Promise<{ generation: number }>;
  close(): Promise<void>;
}

const defaultFsByName = new Map<string, MemoryFs>();
const defaultHosts = new Map<string, EngineHost>();

function defaultMemoryFs(name: DbName): MemoryFs {
  let fs = defaultFsByName.get(name);
  if (!fs) {
    fs = new MemoryFs();
    defaultFsByName.set(name, fs);
  }
  return fs;
}

function localIngest(name: DbName, fs: AsyncFs): IngestClient {
  let host = defaultHosts.get(name);
  if (!host) {
    host = new EngineHost(() => fs);
    defaultHosts.set(name, host);
  }
  return createLocalIngestClient(host);
}

function canUseBrowserOpfs(): boolean {
  return (
    typeof SharedWorker !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

export function __resetMemoryFsForTests(name: string): void {
  defaultFsByName.delete(name);
  defaultHosts.delete(name);
}

export function prefixBound(prefix: Uint8Array): {
  start: Uint8Array;
  endExclusive?: Uint8Array;
} {
  const start = checkKey(prefix);
  const end = successor(start);
  return end === undefined ? { start } : { start, endExclusive: end };
}

/** What `@opfs-lsm/kv/testing` reads from an open Db. */
export type DbInternals = {
  readonly name: DbName;
  readonly wal: IdBWal;
  readonly fs: CountingFs;
  readonly ingest: IngestClient;
};

const internals = new WeakMap<Db, DbInternals>();

/** Undefined for a Db not opened by `openDbWith`. */
export function dbInternals(db: Db): DbInternals | undefined {
  return internals.get(db);
}

export async function openDb(options: OpenOptions): Promise<Db> {
  return openDbWith(options);
}

/** Full open path used by `openDb` and `@opfs-lsm/kv/testing`. */
export async function openDbWith(options: HarnessOpenOptions): Promise<Db> {
  const trace = options.trace;
  const openAt = trace ? performance.now() : 0;
  const name = checkDbName(options.name);
  // Reads unpack LZ4 blocks faster once wasm loads. Until then they use the JS decoder.
  const wasmAt = trace ? performance.now() : 0;
  const engine = ensureEngine();
  if (trace) {
    void engine.then(
      () => span(trace, "wasm", performance.now() - wasmAt),
      () => span(trace, "wasm-error", performance.now() - wasmAt),
    );
  }
  const policy: IngestPolicy = {
    ...DEFAULT_INGEST_POLICY,
    ...options.ingestPolicy,
  };
  const caps = memtableCaps(options.memtableBytes);

  let fs = options.fs;
  let ingest = options.ingest;
  let ownsIngestClient = false;

  const callerChoseStorage =
    options.forceMemory === true || fs !== undefined || ingest !== undefined;
  const browserOpfs = canUseBrowserOpfs();
  const useBrowser = !callerChoseStorage && browserOpfs;

  if (
    typeof document !== "undefined" &&
    !callerChoseStorage &&
    !browserOpfs &&
    options.allowEphemeral !== true
  ) {
    throw new StorageUnavailableError(
      "browser openDb needs SharedWorker and navigator.storage.getDirectory",
    );
  }

  if (useBrowser) {
    const opfsAt = trace ? performance.now() : 0;
    fs = await openBrowserFs(name);
    span(trace, "opfs", performance.now() - opfsAt);
    const workerAt = trace ? performance.now() : 0;
    // The URL stays inline in the constructor: bundlers (Vite, webpack 5)
    // only emit a worker chunk for this exact shape. Built in a helper, Vite
    // treated it as a plain asset and inlined the unbundled entry as a
    // data: URL whose relative imports could not resolve.
    const worker = new SharedWorker(
      new URL("./host/shared-worker.js", import.meta.url),
      { type: "module", name: `opfs-lsm:${name}` },
    );
    span(trace, "worker-ctor", performance.now() - workerAt);
    ingest = createPortIngestClient(
      worker.port,
      trace ? (scan) => recordWatchScan(trace, scan) : undefined,
    );
    ownsIngestClient = true;
  } else {
    if (!fs) fs = defaultMemoryFs(name);
    if (!ingest) ingest = localIngest(name, fs);
  }
  // Wrapped after the local host got the bare fs, so its IO counts only on the host.
  const tabFs = new CountingFs(fs);

  const idbAt = trace ? performance.now() : 0;
  const wal = await IdBWal.open(name);
  span(trace, "idb-open", performance.now() - idbAt);
  const generationAt = trace ? performance.now() : 0;
  // Pair the WAL with a manifest before the first read or write. The
  // recorded manifest's runs are checked by the first sync, which loads them.
  await reconcile(wal, tabFs, TRUST_RECORDED);
  span(trace, "generation", performance.now() - generationAt);
  const writerId = (options.writerId ?? newWriterId()) as WriterId;
  const cache = new PageCache(
    Math.max(MIN_MEMORY_BUDGET, options.memoryBudget ?? DEFAULT_BUDGET),
  );
  const db = new DbImpl(
    name,
    writerId,
    wal,
    tabFs,
    cache,
    ingest,
    ownsIngestClient,
    caps,
    trace,
  );
  internals.set(db, { name, wal, fs: tabFs, ingest });
  const syncAt = trace ? performance.now() : 0;
  await db.sync();
  span(trace, "sync", performance.now() - syncAt);
  // The host takes the smallest limit across tabs, so this tab's soft cap counts as one.
  ingest.watch(name, {
    ...policy,
    maxWalBytes: Math.min(policy.maxWalBytes, caps.soft),
    compactionMemoryBytes: options.compactionMemoryBytes ?? DEFAULT_COMPACTION_MEMORY_BYTES,
  });
  span(trace, "open", performance.now() - openAt);
  return db;
}

function valueOf(row: MemRow): Uint8Array | undefined {
  return row.kind === "put" ? new Uint8Array(row.value!) : undefined;
}

function collectBatch(
  build: (tx: BatchTx) => unknown,
): readonly CheckedOp[] {
  const ops: { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }[] =
    [];
  const ret = build({
    put: (key, value) => {
      ops.push({ type: "put", key, value });
    },
    delete: (key) => {
      ops.push({ type: "del", key });
    },
  });
  if (
    ret !== undefined &&
    ret !== null &&
    typeof (ret as { then?: unknown }).then === "function"
  ) {
    throw new ConstraintError("callback must not return a thenable");
  }
  return checkBatch(ops);
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
  readonly generation: number;
  readonly runs: readonly Run[];
  /** The readers as scan sources, newest first. */
  readonly levels: readonly RunLevel[];
  readonly tombstoneSeq: number;
  refs: number;
};

/** Runs opened at once while loading a generation. */
const OPEN_CONCURRENCY = 16;

type BusMessage = {
  readonly kind: "append" | "ingest";
  readonly writerId: string;
  readonly seq?: number;
  readonly ops?: readonly CheckedOp[];
};

/** Tries under the reclaim lock: each failure means files really are gone. */
const GENERATION_RETRIES = 8;
const TRUST_RECORDED = (): boolean => true;
const CHECK_RECORDED = (): boolean => false;
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
    generation: 0,
    runs: [],
    levels: [],
    tombstoneSeq: 0,
    refs: 1,
  };
  /** The newest generation loaded and not yet installed. */
  private loaded: Layers | undefined;
  /** Open runs of every held generation by path. Paths are immutable, so a hit never goes stale. */
  private readonly runs = new Map<string, Run>();
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private readonly changeBus = new ChangeBus();
  /** Applied and not yet announced, in seq order. Drained outside IndexedDB callbacks. */
  private unannounced: ChangeEvent[] = [];
  /** A repair may have recorded another manifest, so the next install can change what reads return. */
  private repaired = false;
  private readonly bus: BroadcastChannel | undefined;
  private readonly onBusMessage: ((ev: MessageEvent) => void) | undefined;
  private readonly pressure: Backpressure;

  constructor(
    readonly name: DbName,
    readonly writerId: WriterId,
    private readonly wal: IdBWal,
    private readonly fs: AsyncFs,
    private readonly cache: PageCache,
    private readonly ingestClient: IngestClient,
    private readonly ownsIngestClient: boolean,
    caps: MemtableCaps,
    private readonly trace?: OpenTrace,
  ) {
    this.pressure = new Backpressure(
      caps,
      () => this.mem.bytes,
      () => this.relieve(),
    );
    if (typeof BroadcastChannel !== "undefined") {
      this.bus = new BroadcastChannel(layersChannel(name));
      this.onBusMessage = (ev: MessageEvent) => this.onMessage(ev.data);
      this.bus.addEventListener("message", this.onBusMessage);
    }
  }

  private onMessage(data: BusMessage | null): void {
    if (this.closed || !data || data.writerId === this.writerId) return;
    if (data.kind === "append" && data.seq !== undefined && data.ops) {
      if (this.applyRecord({ seq: data.seq, ops: data.ops }) === "gap") {
        void this.sync().catch(() => undefined);
      }
      this.announce();
    } else {
      void this.sync().catch(() => undefined);
      this.emit({ kind: "ingest", writerId: data.writerId });
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("database is closed");
  }

  private broadcast(message: BusMessage): void {
    if (this.closed) return;
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
  private advance(through: number): void {
    if (this.mem.advanceTo(through) || this.repaired) {
      this.repaired = false;
      this.unannounced.push({ kind: "gap", through: this.mem.appliedThrough });
    }
  }

  private announce(): void {
    const events = this.unannounced;
    this.unannounced = [];
    for (const event of events) this.changeBus.emit(event);
  }

  private emit(event: ChangeEvent): void {
    this.unannounced.push(event);
    this.announce();
  }

  /**
   * Make `generation` the loaded one, opening its runs when needed.
   * Generations only grow, so one at or below the installed one is stale
   * and never loaded. False when its manifest or one of its runs is gone.
   */
  private async load(generation: number): Promise<boolean> {
    if (generation <= this.installed.generation) return true;
    if (this.loaded && this.loaded.generation >= generation) return true;
    const meta = await loadGeneration(this.fs, generation);
    if (!meta) return false;
    const paths = meta.runs.map((r) => r.path);
    const runs: (Run | undefined)[] = [];
    let next = 0;
    let gone = false;
    const openNext = async (): Promise<void> => {
      while (next < paths.length && !gone) {
        const i = next++;
        runs[i] = await this.openRun(meta.runs[i]!);
        if (!runs[i]) gone = true;
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(OPEN_CONCURRENCY, paths.length) }, openNext),
    );
    const held = runs.filter((r) => r !== undefined);
    const failed = settled.find((r) => r.status === "rejected");
    if (
      failed ||
      held.length < paths.length ||
      this.closed ||
      generation <= this.installed.generation ||
      (this.loaded && this.loaded.generation >= generation)
    ) {
      this.dropRuns(held);
      if (failed) throw failed.reason;
      return held.length === paths.length;
    }
    if (this.loaded) this.release(this.loaded);
    this.loaded = {
      generation,
      runs: held,
      levels: runLevels(paths, held.map((r) => r.reader)),
      tombstoneSeq: meta.tombstoneSeq,
      refs: 1,
    };
    return true;
  }

  /**
   * The open run at `path`, counted for one more `Layers`. Undefined when
   * the file is gone, which the generation retries handle. Reads no run
   * bytes: the reader loads its layout and pages on first use.
   */
  private async openRun({ path, range }: RunMeta): Promise<Run | undefined> {
    let run = this.runs.get(path);
    if (!run) {
      const file = await this.fs.open(path);
      if (!file) return undefined;
      run = this.runs.get(path);
      if (run) {
        file.close();
      } else {
        run = { path, file, reader: new SstReader(file, this.cache, range), layers: 0 };
        this.runs.set(path, run);
      }
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

  /**
   * Apply `tail` to the memtable. Synchronous, so it can run inside an
   * IndexedDB transaction. Returns the generation to load when the tail
   * needs one this tab does not have yet.
   */
  private catchUp(tail: WalTail): number | undefined {
    const behind = tail.ingestedThrough > this.mem.appliedThrough;
    // A tail read before a newer generation was installed: its records are
    // still a WAL prefix, but its generation and ingestedThrough are stale.
    if (tail.generation > this.installed.generation) {
      const layers =
        this.loaded?.generation === tail.generation ? this.loaded : undefined;
      if (layers) {
        this.release(this.installed);
        this.installed = layers;
        this.loaded = undefined;
      } else if (behind) {
        return tail.generation;
      }
    }
    if (this.loaded && this.loaded.generation <= this.installed.generation) {
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
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  /**
   * Catch up once without the reclaim lock, the usual path. A run or
   * manifest that went missing mid-load was almost always reclaimed after
   * a newer generation replaced it, and under churn that can repeat on
   * every try. So the retries hold the reclaim lock shared: the host
   * removes no file until they return, and the generation a retry reads
   * keeps every file (design.md, "Loading a generation under churn").
   */
  private async syncOnce(): Promise<void> {
    if ((await this.catchUpOnce()) === "done") return;
    await holdingFiles(this.name, async () => {
      for (let gone = 0; ; ) {
        const step = await this.catchUpOnce();
        if (step === "done") return;
        if (step === "gone") gone = await this.repairGone(gone);
      }
    });
  }

  /**
   * Read the tail and catch up to it. "behind" when another load installed
   * a newer generation meanwhile, "gone" when the tail's generation lacks
   * a file.
   */
  private async catchUpOnce(): Promise<"done" | "behind" | "gone"> {
    const profile: WalReadProfile | undefined = this.trace
      ? { ms: 0, rows: 0 }
      : undefined;
    const tail = await this.wal.tail(this.mem.appliedThrough, profile);
    if (profile) {
      span(this.trace, "wal-read", profile.ms, { rows: profile.rows });
    }
    if (this.closed) return "done";
    const sstAt = this.trace ? performance.now() : 0;
    let whole = true;
    if (tail.generation !== this.installed.generation) {
      whole = await this.load(tail.generation);
      if (this.closed) return "done";
    }
    if (this.trace) span(this.trace, "sst", performance.now() - sstAt);
    const memAt = this.trace ? performance.now() : 0;
    let missing: number | undefined;
    try {
      missing = this.catchUp(tail);
    } finally {
      this.announce();
    }
    if (this.trace) {
      span(
        this.trace,
        "memtable",
        performance.now() - memAt,
        profile ? { rows: profile.rows } : undefined,
      );
    }
    if (missing === undefined) return "done";
    return whole ? "behind" : "gone";
  }

  /**
   * A load under the reclaim lock found a file of the recorded generation
   * gone. Nothing the host does removes one while the lock is held, so the
   * files really are gone: repair, and give up after `GENERATION_RETRIES`.
   * Returns the new count. Call holding the lock.
   */
  private async repairGone(gone: number): Promise<number> {
    if (gone + 1 >= GENERATION_RETRIES) throw new CorruptDatabaseError(GENERATION_GONE);
    await this.repair();
    return gone + 1;
  }

  /**
   * The recorded generation did not load. Usually a newer one replaced it
   * and the next tail names that one. After a power loss its manifest or
   * runs can be gone for good: `reconcile` then records one that pairs
   * with the WAL (design.md, "Recovery"). It changes nothing while
   * IndexedDB names a generation other than the one found broken.
   */
  private async repair(): Promise<void> {
    await reconcile(this.wal, this.fs, CHECK_RECORDED);
    this.repaired = true;
  }

  /**
   * Join this tab's committed record to the memtable and announce it before
   * the ack resolves. A gap means another tab appended first: catch up,
   * which reads the record too.
   */
  private async landed(seq: number, ops: readonly CheckedOp[]): Promise<void> {
    if (this.applyRecord({ seq, ops }) === "gap" && !this.closed) await this.sync();
    this.pressure.landed();
    this.announce();
    this.broadcast({ kind: "append", writerId: this.writerId, seq, ops });
  }

  /**
   * Wait out a full memtable before a write (`Backpressure`). Called only
   * when it is full: a write with room must start its append in the turn it
   * was called, or a `close` right after a `put` would beat the append.
   */
  private async admit(): Promise<void> {
    await this.pressure.admit();
    this.ensureOpen();
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
   * appends nothing either: the tab loads it, and from then on each try
   * holds the reclaim lock, as in `syncOnce`. It first waits out a full
   * memtable (`admit`). Resolves with the appended seq, undefined when
   * `plan` chose no ops, and `plan`'s result.
   */
  private async write<R>(
    plan: () => Maybe<{ readonly ops: readonly CheckedOp[]; readonly result: R }>,
    warm?: () => Promise<unknown>,
  ): Promise<{ readonly seq: number | undefined; readonly result: R }> {
    if (this.pressure.full) await this.admit();
    let locked = false;
    let gone = 0;
    for (;;) {
      await warm?.();
      const step = async () => {
        let missing: number | undefined;
        let miss: Miss | undefined;
        const out = await this.wal
          .appendAfter(this.mem.appliedThrough, (tail) => {
            missing = this.catchUp(tail);
            if (missing !== undefined) return undefined;
            const planned = plan();
            if (!(planned instanceof Miss)) return planned;
            miss = planned;
            return undefined;
          })
          .finally(() => this.announce());
        if (out || miss) return { out, miss };
        const whole = missing === undefined || (await this.load(missing));
        if (whole || !locked) return {};
        gone = await this.repairGone(gone);
        return {};
      };
      const { out, miss } = locked ? await holdingFiles(this.name, step) : await step();
      if (out) {
        if (out.seq !== undefined) await this.landed(out.seq, out.ops);
        return out;
      }
      if (miss) {
        // The next warm reads again and surfaces a real failure.
        await miss.ready.catch(() => undefined);
        continue;
      }
      locked = true;
    }
  }

  /**
   * Runs `attempt` over the installed levels until it stops missing. While
   * it waits it holds those levels, so a generation installed meanwhile
   * cannot let the host delete the files it is reading.
   */
  private async settleInstalled<T>(
    attempt: (levels: readonly RunLevel[]) => Maybe<T>,
  ): Promise<T> {
    const layers = this.installed;
    const first = attempt(layers.levels);
    if (!(first instanceof Miss)) return first;
    this.retain(layers);
    try {
      await first.ready;
      return await settle(() => attempt(layers.levels));
    } finally {
      this.release(layers);
    }
  }

  /** Every key read, or one Miss for all the bytes they lack. */
  private readKeys(
    ks: readonly CheckedKey[],
    levels: readonly RunLevel[],
  ): Maybe<(Uint8Array | undefined)[]> {
    const values: (Uint8Array | undefined)[] = [];
    let misses: Miss[] | undefined;
    for (const k of ks) {
      const row = this.mem.get(k);
      const v = row ? valueOf(row) : pointGetSst(levels, k);
      if (v instanceof Miss) (misses ??= []).push(v);
      else values.push(v);
    }
    return misses ? allMissed(misses) : values;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    const row = this.mem.get(k);
    if (row) return valueOf(row);
    return this.settleInstalled((levels) => pointGetSst(levels, k));
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
    if (this.pressure.full) await this.admit();
    const seq = await this.wal.append(ops);
    if (seq === undefined) return (await this.write(() => ({ ops, result: undefined }))).seq!;
    await this.landed(seq, ops);
    return seq;
  }

  async update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    const out = await this.write(() => {
      const values = this.readKeys(ks, this.installed.levels);
      if (values instanceof Miss) return values;
      let result!: T;
      const ops = collectBatch((tx) => {
        result = body(values, tx);
        return result;
      });
      return { ops, result };
    }, () => this.settleInstalled((levels) => this.readKeys(ks, levels)));
    return out.result;
  }

  async rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const rows = this.mem.pin();
    const layers = this.installed;
    this.retain(layers);
    try {
      const out: { entry: Entry; value: Uint8Array | undefined }[] = [];
      for await (const entry of scanLayers(rows.range(bounds), layers.levels, bounds, range)) {
        const key = follow(entry);
        let value: Uint8Array | undefined;
        if (key !== undefined) {
          const k = checkKey(key);
          const row = rows.get(k);
          const got = row ? valueOf(row) : pointGetSst(layers.levels, k);
          value = got instanceof Miss ? await settle(() => pointGetSst(layers.levels, k)) : got;
        }
        out.push({ entry, value });
      }
      return out;
    } finally {
      this.release(layers);
    }
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const layers = this.installed;
    this.retain(layers);
    try {
      for await (const entry of scanLayers(this.mem.range(bounds), layers.levels, bounds, range)) {
        this.ensureOpen();
        yield entry;
      }
    } finally {
      this.release(layers);
    }
  }

  async view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const layers = this.installed;
    this.retain(layers);
    const snap = new ViewSnapshotImpl(
      this.mem.appliedThrough,
      layers.generation,
      this.mem.pin(),
      layers.levels,
      () => {
        this.retain(layers);
        return () => this.release(layers);
      },
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
    return this.changeBus.subscribe(listener);
  }

  ingest(): Promise<{ generation: number }> {
    return this.flush(true);
  }

  /** Have the host flush the WAL, tell the other tabs if that moved the generation, and load it. */
  private async flush(settle: boolean): Promise<{ generation: number }> {
    this.ensureOpen();
    const before = this.installed.generation;
    const result = await this.ingestClient.ingest(
      this.name,
      Number.POSITIVE_INFINITY,
      settle,
    );
    if (result.generation !== before) {
      this.emit({ kind: "ingest", writerId: this.writerId });
      this.broadcast({ kind: "ingest", writerId: this.writerId });
    }
    await this.sync();
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit({ kind: "closed" });
    this.changeBus.clear();
    if (this.bus && this.onBusMessage) {
      this.bus.removeEventListener("message", this.onBusMessage);
      this.bus.close();
    }
    this.ingestClient.unwatch(this.name);
    if (this.ownsIngestClient) this.ingestClient.close();
    this.wal.close();
    this.release(this.installed);
    if (this.loaded) this.release(this.loaded);
    this.loaded = undefined;
  }
}
