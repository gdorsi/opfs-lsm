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
import {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
  type WatchScan,
} from "./host/engine-host.js";
import { layersChannel, type IngestClient } from "./host/protocol.js";
import { IdBWal, type WalReadProfile, type WalTail } from "./idb/wal.js";
import { Memtable, type MemRow } from "./store/memtable.js";
import { allMissed, Miss, settle, type Maybe } from "./store/cursor.js";
import { DEFAULT_INGEST_POLICY, type IngestPolicy } from "./ingest-policy.js";
import type { AsyncFs, OpenFile } from "./opfs/async-fs.js";
import { openBrowserFs } from "./opfs/browser-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";
import {
  loadGeneration,
  loadLatestGeneration,
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
export type { ChangeEvent, ChangeListener, ChangeKind } from "./changes.js";

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
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
  readonly limit?: number;
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
  readonly writerId: WriterId;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  /**
   * `build` runs synchronously. Promise resolves after the shared IDB WAL
   * commit. Other tabs see the write when its BroadcastChannel message
   * arrives, a moment after the ack, or after their next `sync()`. The ingest host
   * flushes the WAL to OPFS per ingestPolicy.
   */
  batch(build: (tx: BatchTx) => void): Promise<void>;
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
   * key, in one IndexedDB transaction. Every read sees the same state.
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
   * Subscribe to durable WAL appends and ingest generation bumps.
   * Fires for this tab's writes and for other tabs (via BroadcastChannel).
   * Returns an unsubscribe function.
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

  const idbAt = trace ? performance.now() : 0;
  const wal = await IdBWal.open(name);
  span(trace, "idb-open", performance.now() - idbAt);
  const generationAt = trace ? performance.now() : 0;
  if ((await wal.recordedGeneration()) === undefined) {
    const manifestAt = performance.now();
    const latest = await loadLatestGeneration(fs);
    span(trace, "manifest", performance.now() - manifestAt);
    await wal.raiseGeneration(latest?.generation ?? 0);
  }
  span(trace, "generation", performance.now() - generationAt);
  const writerId = (options.writerId ?? newWriterId()) as WriterId;
  const cache = new PageCache(
    Math.max(MIN_MEMORY_BUDGET, options.memoryBudget ?? DEFAULT_BUDGET),
  );
  const db = new DbImpl(
    name,
    writerId,
    wal,
    fs,
    cache,
    ingest,
    ownsIngestClient,
    trace,
  );
  const syncAt = trace ? performance.now() : 0;
  await db.sync();
  span(trace, "sync", performance.now() - syncAt);
  ingest.watch(name, policy);
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

const GENERATION_RETRIES = 8;
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
  private readonly bus: BroadcastChannel | undefined;
  private readonly onBusMessage: ((ev: MessageEvent) => void) | undefined;

  constructor(
    readonly name: DbName,
    readonly writerId: WriterId,
    private readonly wal: IdBWal,
    private readonly fs: AsyncFs,
    private readonly cache: PageCache,
    private readonly ingestClient: IngestClient,
    private readonly ownsIngestClient: boolean,
    private readonly trace?: OpenTrace,
  ) {
    if (typeof BroadcastChannel !== "undefined") {
      this.bus = new BroadcastChannel(layersChannel(name));
      this.onBusMessage = (ev: MessageEvent) => this.onMessage(ev.data);
      this.bus.addEventListener("message", this.onBusMessage);
    }
  }

  private onMessage(data: BusMessage | null): void {
    if (this.closed || !data || data.writerId === this.writerId) return;
    if (data.kind === "append" && data.seq !== undefined && data.ops) {
      if (!this.mem.apply({ seq: data.seq, ops: data.ops })) {
        void this.sync().catch(() => undefined);
      }
    } else {
      void this.sync().catch(() => undefined);
    }
    this.changeBus.emit({
      kind: data.kind,
      writerId: data.writerId,
      ...(data.seq !== undefined ? { seq: data.seq } : {}),
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("database is closed");
  }

  private broadcast(message: BusMessage): void {
    if (this.closed) return;
    this.bus?.postMessage(message);
  }

  private emitChange(event: ChangeEvent): void {
    this.changeBus.emit(event);
  }

  /**
   * Make `generation` the loaded one, opening its runs when needed.
   * Generations only grow, so one at or below the installed one is stale
   * and never loaded.
   */
  private async load(generation: number): Promise<void> {
    if (generation <= this.installed.generation) return;
    if (this.loaded && this.loaded.generation >= generation) return;
    const meta = await loadGeneration(this.fs, generation);
    if (!meta) return;
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
      return;
    }
    if (this.loaded) this.release(this.loaded);
    this.loaded = {
      generation,
      runs: held,
      levels: runLevels(paths, held.map((r) => r.reader)),
      tombstoneSeq: meta.tombstoneSeq,
      refs: 1,
    };
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
      this.mem.advanceTo(tail.ingestedThrough);
    }
    for (const record of tail.records) {
      if (!this.mem.apply(record)) {
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

  private async syncOnce(): Promise<void> {
    for (let attempt = 0; attempt < GENERATION_RETRIES; attempt++) {
      const profile: WalReadProfile | undefined = this.trace
        ? { ms: 0, rows: 0 }
        : undefined;
      const tail = await this.wal.tail(this.mem.appliedThrough, profile);
      if (profile) {
        span(this.trace, "wal-read", profile.ms, { rows: profile.rows });
      }
      if (this.closed) return;
      const sstAt = this.trace ? performance.now() : 0;
      if (tail.generation !== this.installed.generation) {
        await this.load(tail.generation);
        if (this.closed) return;
      }
      if (this.trace) span(this.trace, "sst", performance.now() - sstAt);
      const memAt = this.trace ? performance.now() : 0;
      const missing = this.catchUp(tail);
      if (this.trace) {
        span(
          this.trace,
          "memtable",
          performance.now() - memAt,
          profile ? { rows: profile.rows } : undefined,
        );
      }
      if (missing === undefined) return;
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
  }

  /**
   * Join this tab's committed record to the memtable before the ack
   * resolves. A gap means another tab appended first: catch up, which
   * reads the record too.
   */
  private async landed(seq: number, ops: readonly CheckedOp[]): Promise<void> {
    if (!this.mem.apply({ seq, ops }) && !this.closed) await this.sync();
    this.emitChange({ kind: "append", writerId: this.writerId, seq });
    this.broadcast({ kind: "append", writerId: this.writerId, seq, ops });
  }

  /**
   * In one readwrite transaction, catch the memtable up, let `plan` choose a
   * batch against it, and append. The batch joins the memtable at its seq,
   * so this tab reads its own write as soon as the ack resolves. Awaiting
   * inside the transaction would commit it, so `warm` loads what `plan`
   * reads before each attempt, and a `plan` that still misses appends
   * nothing and is retried.
   */
  private async write<R>(
    plan: () => Maybe<{ readonly ops: readonly CheckedOp[]; readonly result: R }>,
    warm?: () => Promise<unknown>,
  ): Promise<R> {
    for (let attempt = 0; attempt < GENERATION_RETRIES; ) {
      await warm?.();
      let missing: number | undefined;
      let miss: Miss | undefined;
      const out = await this.wal.appendAfter(this.mem.appliedThrough, (tail) => {
        missing = this.catchUp(tail);
        if (missing !== undefined) return undefined;
        const planned = plan();
        if (!(planned instanceof Miss)) return planned;
        miss = planned;
        return undefined;
      });
      if (out) {
        if (out.seq !== undefined) await this.landed(out.seq, out.ops);
        return out.result;
      }
      if (miss) {
        // The next warm reads again and surfaces a real failure.
        await miss.ready.catch(() => undefined);
        continue;
      }
      attempt++;
      if (missing !== undefined) await this.load(missing);
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
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

  put(key: Uint8Array, value: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.put(key, value));
  }

  delete(key: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.delete(key));
  }

  async batch(build: (tx: BatchTx) => void): Promise<void> {
    this.ensureOpen();
    const ops = collectBatch(build);
    if (ops.length === 0) return;
    const seq = await this.wal.append(ops);
    if (seq === undefined) await this.write(() => ({ ops, result: undefined }));
    else await this.landed(seq, ops);
  }

  async update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    return this.write(() => {
      const values = this.readKeys(ks, this.installed.levels);
      if (values instanceof Miss) return values;
      let result!: T;
      const ops = collectBatch((tx) => {
        result = body(values, tx);
        return result;
      });
      return { ops, result };
    }, () => this.settleInstalled((levels) => this.readKeys(ks, levels)));
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

  async ingest(): Promise<{ generation: number }> {
    this.ensureOpen();
    const before = this.installed.generation;
    const result = await this.ingestClient.ingest(
      this.name,
      Number.POSITIVE_INFINITY,
      true,
    );
    if (result.generation !== before) {
      this.emitChange({ kind: "ingest", writerId: this.writerId });
      this.broadcast({ kind: "ingest", writerId: this.writerId });
    }
    await this.sync();
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
