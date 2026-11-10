import { successor } from "./bytes.js";
import { checkBatch, checkDbName, checkKey, opsBytes, type CheckedKey, type CheckedOp, type DbName } from "./check.js";
import { ChangeBus, type ChangeEvent, type ChangeListener } from "./changes.js";
import { ClosedError, CommitError, ConstraintError, CorruptDatabaseError, StorageUnavailableError } from "./errors.js";
import { Host } from "./host/host.js";
import { HostLink, type LinkPort } from "./host/link.js";
import { layersChannel, parseGenerationNote, type HostStats } from "./host/protocol.js";
import type { LogId, QueueCursor } from "./host/queues.js";
import { holdingFiles } from "./locks.js";
import { LogClient, type SpawnLogWorker } from "./log/client.js";
import { localLogWorkers } from "./log/local-log-worker.js";
import { OwnQueue } from "./log/overlay.js";
import type { SegmentStore } from "./log/queue-writer.js";
import type { AsyncFs, OpenFile } from "./opfs/async-fs.js";
import { openBrowserFs } from "./opfs/browser-fs.js";
import { CountingFs } from "./opfs/counting-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";
import { newestIntact } from "./recover.js";
import { allMissed, Miss, settle, type Maybe } from "./store/cursor.js";
import { ensureEngine } from "./store/engine.js";
import { loadGeneration, type GenerationMeta, type RunMeta } from "./store/generation.js";
import type { MemRow } from "./store/memtable.js";
import { pointGetSst, runLevels, type RunLevel } from "./store/merge.js";
import { DEFAULT_BUDGET, PageCache } from "./store/page-cache.js";
import { SstReader } from "./store/sst-reader.js";
import { ViewSnapshotImpl, boundsOf, scanLayers, type ViewSnapshot } from "./view.js";

export type { ViewSnapshot } from "./view.js";
export type { ChangeEvent, ChangeListener, ChangeKind } from "./changes.js";

/** Public open options. Apps pass a database name; the library owns the rest. */
export type OpenOptions = {
  readonly name: string;
  /**
   * Bytes of run files this tab keeps in memory: cached data pages plus
   * each run's Bloom filter and block index. Default 256 MiB, at least
   * 1 MiB. It does not cover this page's writes the host has not ingested
   * yet (`pendingBytes`), the wasm heap, or values handed to the caller.
   * Each `openDb` has its own budget.
   */
  readonly memoryBudget?: number;
  /**
   * Key and value bytes of this page's writes that the host has not
   * ingested yet, at most. They stay in memory so reads see them. Past it
   * a write waits for an ingest, and rejects with `CommitError` after 30 s.
   * Default 32 MiB, at least 1 MiB. A write larger than the cap goes once
   * nothing else is pending.
   */
  readonly pendingBytes?: number;
};

/** Below this, one page per merge source may not fit. */
const MIN_MEMORY_BUDGET = 1024 * 1024;
const DEFAULT_PENDING_BYTES = 32 * 1024 * 1024;
const MIN_PENDING_BYTES = 1024 * 1024;
/** How long a write waits for room under `pendingBytes`. */
const ROOM_WAIT_MS = 30_000;
/** A segment file of a log: about one ingest round's worth of writes, so reclaim frees space often. */
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;

/**
 * Harness / test open options (`openHarnessDb` in `@opfs-lsm/kv/testing`).
 * Not part of the app-facing API.
 */
export type HarnessOpenOptions = OpenOptions & {
  /**
   * Runs and manifests this page reads: the files its host publishes. Omit
   * in the browser for OPFS, and in Node for one MemoryFs per name.
   */
  readonly fs?: AsyncFs;
  /** Where this page's logs go when their writers run on this thread. Default: `fs.segments`. */
  readonly segments?: SegmentStore;
  /** The host this page talks to over a MessageChannel. Default: one per `fs` on this thread. */
  readonly host?: Host;
  /** Starts the writer of each log. Default: a dedicated WebWorker in the browser, this thread otherwise. */
  readonly spawn?: SpawnLogWorker;
  /** Size of one log segment file. Default 4 MiB. */
  readonly segmentBytes?: number;
  /** Force the Node/test path (MemoryFs, a host and log writers on this thread) even in a browser. */
  readonly forceMemory?: boolean;
  /**
   * Use MemoryFs when this page has no SharedWorker or OPFS.
   * Data lives only until the page closes. Ignored when OPFS can open,
   * and ignored in Node, which already defaults to MemoryFs.
   */
  readonly allowEphemeral?: boolean;
  /** When set, open records phase durations here. Wasm init can append after the open promise resolves. */
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

function span(trace: OpenTrace | undefined, phase: string, ms: number, extra?: { rows?: number; bytes?: number }): void {
  if (!trace) return;
  trace.spans.push({ phase, ms, endedAt: performance.now(), ...extra });
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

/**
 * A database as one page sees it. Reads see the installed manifest, which
 * holds a prefix of the ingest order, with this page's acked writes it does
 * not hold yet on top. The installed manifest only moves forward. Other
 * pages' writes show up when the host ingests them, about a second after
 * their ack, or after `sync()`.
 *
 * Writes reject with `CommitError` when they never apply, and with
 * `IndeterminateWriteError` when they were sent and may still apply after a
 * failure, but never after a later write of this page.
 */
export interface Db {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  /**
   * `build` runs synchronously. The batch is one record of this page's log:
   * it applies whole or not at all. The promise resolves once the record is
   * written, and reads on this page see it from then on.
   */
  batch(build: (tx: BatchTx) => void): Promise<void>;
  /**
   * Read `keys`, then write what `body` puts. `body` runs synchronously with
   * the values this page reads after its earlier writes are acked. The
   * write is last-writer-wins: another page's write to the same keys that
   * is ingested after this one replaces it, even if it read older values.
   * Updates on one page run one after another, so they never lose each
   * other's writes.
   */
  update<T>(keys: readonly Uint8Array[], body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T): Promise<T>;
  /**
   * Scan `range`, then point-read `follow(entry)` for each entry that returns a
   * key. The scan and the reads see one state, although a page load can make
   * them wait. Writes that land meanwhile are not seen.
   */
  rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]>;
  range(range?: Range): AsyncIterable<Entry>;
  /** Read-only snapshot: the installed manifest and this page's writes as they were when the view opened. */
  view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T>;
  /** Subscribe to this page's acked writes and to installs of new manifests. Returns an unsubscribe function. */
  changes(listener: ChangeListener): () => void;
  /**
   * Install a manifest that holds this page's writes acked before the call,
   * and every other page's writes flushed before it. The host asks the other
   * pages to flush and waits for them at most 500 ms.
   */
  sync(): Promise<void>;
  /** `sync()`, then compaction until a pass installs nothing. */
  ingest(): Promise<{ generation: number }>;
  close(): Promise<void>;
}

const defaultFsByName = new Map<string, MemoryFs>();
const defaultHosts = new WeakMap<AsyncFs, Host>();

function defaultMemoryFs(name: DbName): MemoryFs {
  let fs = defaultFsByName.get(name);
  if (!fs) {
    fs = new MemoryFs();
    defaultFsByName.set(name, fs);
  }
  return fs;
}

function defaultHost(fs: AsyncFs): Host {
  let host = defaultHosts.get(fs);
  if (!host) {
    host = new Host(() => fs);
    defaultHosts.set(fs, host);
  }
  return host;
}

function segmentsOf(fs: AsyncFs): SegmentStore {
  const segments = (fs as { segments?: SegmentStore }).segments;
  if (!segments) throw new ConstraintError("fs has no segment store: pass `segments`");
  return segments;
}

function canUseBrowserOpfs(): boolean {
  return (
    typeof SharedWorker !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

export function __resetMemoryFsForTests(name: string): void {
  defaultFsByName.delete(name);
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
  readonly fs: CountingFs;
  readonly hostStats: () => Promise<HostStats>;
  /** Records this page appended, and their key and value bytes. */
  readonly appended: () => { readonly records: number; readonly bytes: number };
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

  const callerChose = options.forceMemory === true || options.fs !== undefined || options.host !== undefined;
  const browserOpfs = canUseBrowserOpfs();
  if (typeof document !== "undefined" && !callerChose && !browserOpfs && options.allowEphemeral !== true) {
    throw new StorageUnavailableError("browser openDb needs SharedWorker, Worker and navigator.storage.getDirectory");
  }

  let fs: AsyncFs;
  let port: LinkPort;
  let spawn = options.spawn;
  let unserve: (() => void) | undefined;
  if (!callerChose && browserOpfs) {
    const opfsAt = trace ? performance.now() : 0;
    fs = await openBrowserFs(name);
    span(trace, "opfs", performance.now() - opfsAt);
    const workerAt = trace ? performance.now() : 0;
    // The URL stays inline in the constructor: bundlers (Vite, webpack 5)
    // only emit a chunk for the SharedWorker for this exact shape. Built in
    // a helper, Vite treated it as a plain asset and inlined the unbundled
    // entry as a data: URL whose relative imports could not resolve.
    const worker = new SharedWorker(new URL("./host/shared-worker.js", import.meta.url), {
      type: "module",
      name: `opfs-lsm:${name}`,
    });
    span(trace, "worker-ctor", performance.now() - workerAt);
    port = worker.port;
  } else {
    fs = options.fs ?? defaultMemoryFs(name);
    spawn ??= localLogWorkers(options.segments ?? segmentsOf(fs));
    const channel = new MessageChannel();
    unserve = (options.host ?? defaultHost(fs)).serve(channel.port2);
    port = channel.port1;
  }
  const cache = new PageCache(Math.max(MIN_MEMORY_BUDGET, options.memoryBudget ?? DEFAULT_BUDGET));
  const db = new DbImpl({
    name,
    fs: new CountingFs(fs),
    cache,
    port,
    unserve,
    spawn,
    segmentBytes: options.segmentBytes ?? DEFAULT_SEGMENT_BYTES,
    pendingBytes: Math.max(MIN_PENDING_BYTES, options.pendingBytes ?? DEFAULT_PENDING_BYTES),
    trace,
  });
  try {
    await db.open();
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
  span(trace, "open", performance.now() - openAt);
  return db;
}

function valueOf(row: MemRow): Uint8Array | undefined {
  return row.kind === "put" ? new Uint8Array(row.value!) : undefined;
}

function collectBatch(build: (tx: BatchTx) => unknown): readonly CheckedOp[] {
  const ops: { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }[] = [];
  const ret = build({
    put: (key, value) => {
      ops.push({ type: "put", key, value });
    },
    delete: (key) => {
      ops.push({ type: "del", key });
    },
  });
  if (ret !== undefined && ret !== null && typeof (ret as { then?: unknown }).then === "function") {
    throw new ConstraintError("callback must not return a thenable");
  }
  return checkBatch(ops);
}

const noop = (): void => undefined;

/** An open run file and the number of `Layers` that list it. */
type Run = {
  readonly path: string;
  readonly file: OpenFile;
  readonly reader: SstReader;
  layers: number;
};

/**
 * One manifest's runs and cursors. `refs` counts its holders: the
 * `installed` slot, each open view, and each live `range()` iterator. The
 * last release lets go of its runs, so the host may delete their files.
 */
type Layers = {
  readonly generation: number;
  readonly runs: readonly Run[];
  /** The readers as scan sources, newest first. */
  readonly levels: readonly RunLevel[];
  readonly queues: readonly QueueCursor[];
  refs: number;
};

/** A write waiting for room under `pendingBytes`, in call order. */
type RoomWaiter = {
  readonly bytes: number;
  readonly go: () => void;
  readonly fail: (err: Error) => void;
  readonly cancel: () => void;
};

/** Runs opened at once while loading a generation. */
const OPEN_CONCURRENCY = 16;

type DbParts = {
  readonly name: DbName;
  readonly fs: CountingFs;
  readonly cache: PageCache;
  readonly port: LinkPort;
  /** Disconnects a host on this thread from the port. */
  readonly unserve: (() => void) | undefined;
  readonly spawn: SpawnLogWorker | undefined;
  readonly segmentBytes: number;
  readonly pendingBytes: number;
  readonly trace: OpenTrace | undefined;
};

/**
 * One page's database. The read state is `installed`, one manifest's runs
 * and cursors, and `own`, this page's acked records those cursors do not
 * cover. Both change together in `install`, one synchronous step, so every
 * read sees the manifest's prefix of the ingest order with this page's
 * later records on top. A write goes to this page's log through
 * `LogClient`, and joins `own` in the task its ack arrives in, before its
 * promise resolves.
 */
class DbImpl implements Db {
  readonly name: DbName;
  private readonly fs: CountingFs;
  private readonly cache: PageCache;
  private readonly trace: OpenTrace | undefined;
  private readonly unserve: (() => void) | undefined;
  private readonly pendingBytes: number;
  private closed = false;
  private readonly own = new OwnQueue();
  private installed: Layers = { generation: 0, runs: [], levels: [], queues: [], refs: 1 };
  /** Open runs of every held generation by path. Paths are immutable, so a hit never goes stale. */
  private readonly runs = new Map<string, Run>();
  private readonly changeBus = new ChangeBus();
  private readonly link: HostLink;
  private readonly client: LogClient;
  private readonly bus: BroadcastChannel | undefined;
  /** Generation loads run one at a time, each for the newest generation asked for. */
  private loading: Promise<void> = Promise.resolve();
  private wanted = 0;
  /** Key and value bytes of appends sent and not yet acked or failed. */
  private sending = 0;
  /** Settles once every append sent so far was acked or failed. */
  private landedAll: Promise<void> = Promise.resolve();
  private readonly roomWaiters: RoomWaiter[] = [];
  private askingForRoom = false;
  /** Updates run one after another, each after the earlier one sent its write. */
  private updates: Promise<unknown> = Promise.resolve();
  /** Live logs whose records past a damaged cursor are being sent again. */
  private readonly restarting = new Set<LogId>();
  private appendedRecords = 0;
  private appendedBytes = 0;
  private readonly onPageHide = (): void => {
    // Every pagehide: for the back/forward cache the log must end, and on unload ending it frees its lock sooner.
    void this.client.suspend();
    this.link.detach();
  };
  private readonly onPageShow = (ev: Event): void => {
    if (!(ev as PageTransitionEvent).persisted || this.closed) return;
    this.client.resume();
    this.link.attach(this.name).then(
      (generation) => this.refresh(generation),
      (err: unknown) => console.error("opfs-lsm: attach after the back/forward cache failed", err),
    );
  };

  constructor(parts: DbParts) {
    this.name = parts.name;
    this.fs = parts.fs;
    this.cache = parts.cache;
    this.trace = parts.trace;
    this.unserve = parts.unserve;
    this.pendingBytes = parts.pendingBytes;
    this.link = new HostLink(parts.port, (rotate) => this.flushFor(rotate));
    this.client = new LogClient({
      db: parts.name,
      segmentBytes: parts.segmentBytes,
      ...(parts.spawn ? { spawn: parts.spawn } : {}),
      durable: (log, n, bytes) => this.link.durable(log, n, bytes),
    });
    if (typeof BroadcastChannel !== "undefined") {
      this.bus = new BroadcastChannel(layersChannel(parts.name));
      this.bus.onmessage = (ev) => {
        const note = parseGenerationNote(ev.data);
        if (note && note.generation > this.installed.generation) {
          // A failure here comes back from the next sync.
          this.refresh(note.generation).catch(noop);
        }
      };
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
    internals.set(this, {
      name: this.name,
      fs: this.fs,
      hostStats: () => this.link.stats(),
      appended: () => ({ records: this.appendedRecords, bytes: this.appendedBytes }),
    });
  }

  /** Joins the host, which ingests what every page flushed, and installs that manifest. */
  async open(): Promise<void> {
    const attachAt = this.trace ? performance.now() : 0;
    const generation = await this.link.attach(this.name);
    span(this.trace, "attach", performance.now() - attachAt);
    await this.refresh(generation);
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("database is closed");
  }

  private emit(event: ChangeEvent): void {
    this.changeBus.emit(event);
  }

  /** The host asked for a flush, and for a rotation when it could not read the live log. */
  private async flushFor(rotate: readonly LogId[]): Promise<void> {
    const live = this.client.live;
    if (live && rotate.includes(live)) await this.client.rotate();
    await this.client.flush();
  }

  /** Install `generation` or a newer one, unless one at least as new is installed. */
  private refresh(generation: number): Promise<void> {
    this.wanted = Math.max(this.wanted, generation);
    const run = (): Promise<void> => this.catchUp();
    const next = this.loading.then(run, run);
    this.loading = next.catch(noop);
    return next;
  }

  /**
   * Load the wanted generation without the reclaim lock, the usual path.
   * When a manifest or run went missing mid-load, a newer generation almost
   * always replaced it, and under churn that can repeat on every try. So
   * the second try holds the reclaim lock shared, which keeps every file,
   * and loads the newest intact manifest (design.md, "Loading a generation
   * under churn").
   */
  private async catchUp(): Promise<void> {
    const want = this.wanted;
    if (this.closed || want <= this.installed.generation) return;
    const loadAt = this.trace ? performance.now() : 0;
    const meta = await loadGeneration(this.fs, want);
    let layers = meta && (await this.load(meta));
    if (!layers) {
      layers = await holdingFiles(this.name, async () => {
        const { base } = await newestIntact(this.fs);
        if (base.generation <= this.installed.generation) return undefined;
        const held = await this.load(base);
        if (!held && !this.closed) throw new CorruptDatabaseError(`a run of generation ${base.generation} went missing under the reclaim lock`);
        return held;
      });
    }
    if (!layers) return;
    span(this.trace, "load", performance.now() - loadAt, { rows: layers.runs.length });
    this.install(layers);
  }

  /** Open `meta`'s runs. Undefined when one is gone or the page closed. */
  private async load(meta: GenerationMeta): Promise<Layers | undefined> {
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
    const settled = await Promise.allSettled(Array.from({ length: Math.min(OPEN_CONCURRENCY, paths.length) }, openNext));
    const held = runs.filter((r) => r !== undefined);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed || held.length < paths.length || this.closed) {
      this.dropRuns(held);
      if (failed) throw failed.reason;
      return undefined;
    }
    return {
      generation: meta.generation,
      runs: held,
      levels: runLevels(
        paths,
        held.map((r) => r.reader),
      ),
      queues: meta.queues ?? [],
      refs: 1,
    };
  }

  /**
   * Swap in `layers` and take its cursors in one synchronous step. A
   * generation at or below the installed one is stale and only released.
   */
  private install(layers: Layers): void {
    if (this.closed || layers.generation <= this.installed.generation) {
      this.release(layers);
      return;
    }
    this.release(this.installed);
    this.installed = layers;
    this.own.install(layers.queues);
    this.resendDamaged(layers.queues);
    this.admit();
    this.emit({ kind: "ingest", generation: layers.generation });
  }

  /**
   * A damaged cursor means no record of its log past `n` is ever ingested.
   * The live log's records past it go to a new log ahead of the writes that
   * wait, and stay readable here until their copies are acked. A log this
   * page already left has a successor with later writes, so its tail cannot
   * go after them: it is dropped, and those acked writes are lost.
   */
  private resendDamaged(queues: readonly QueueCursor[]): void {
    for (const c of queues) {
      if (c.state !== "damaged" || this.restarting.has(c.log)) continue;
      const tail = this.own.above(c.log, c.n);
      if (tail.length === 0) continue;
      const copies = this.client.restart(c.log, tail.map((r) => r.ops));
      if (!copies) {
        console.error(`opfs-lsm: ${tail.length} acked writes of log ${c.log} past record ${c.n} are lost: ${c.reason}`);
        this.own.retire(c.log);
        continue;
      }
      this.restarting.add(c.log);
      const landed = copies.map((acked, i) => acked.then((at) => this.own.add(at.log, at.n, tail[i]!.ops)));
      void Promise.allSettled(landed).then((results) => {
        const lost = results.filter((r) => r.status === "rejected").length;
        if (lost > 0) console.error(`opfs-lsm: ${lost} acked writes of damaged log ${c.log} did not reach its successor`);
        this.own.retire(c.log);
        this.restarting.delete(c.log);
      });
    }
  }

  /**
   * The open run at `path`, counted for one more `Layers`. Undefined when
   * the file is gone. Reads no run bytes: the reader loads its layout and
   * pages on first use.
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

  async sync(): Promise<void> {
    this.ensureOpen();
    await this.client.flush();
    await this.refresh(await this.link.sync());
  }

  async ingest(): Promise<{ generation: number }> {
    this.ensureOpen();
    await this.client.flush();
    const generation = await this.link.settle();
    await this.refresh(generation);
    return { generation };
  }

  /** Room for `bytes` more under `pendingBytes`. A write alone goes whatever its size. */
  private fits(bytes: number): boolean {
    const held = this.own.bytes + this.sending;
    return held === 0 || held + bytes <= this.pendingBytes;
  }

  /** Runs `go` now if nothing waits and `bytes` fit, else once they do, in call order. */
  private whenRoom<T>(bytes: number, go: () => Promise<T>): Promise<T> {
    if (this.roomWaiters.length === 0 && this.fits(bytes)) return go();
    return new Promise<T>((resolve, reject) => {
      const waiter: RoomWaiter = {
        bytes,
        go: () => go().then(resolve, reject),
        fail: reject,
        cancel: after(ROOM_WAIT_MS, () => {
          this.roomWaiters.splice(this.roomWaiters.indexOf(waiter), 1);
          reject(new CommitError(`${this.own.bytes} bytes of this page's writes were not ingested in ${ROOM_WAIT_MS} ms`));
          this.admit();
        }),
      };
      this.roomWaiters.push(waiter);
      this.askForRoom();
    });
  }

  private admit(): void {
    while (this.roomWaiters.length > 0 && this.fits(this.roomWaiters[0]!.bytes)) {
      const waiter = this.roomWaiters.shift()!;
      waiter.cancel();
      waiter.go();
    }
    this.askForRoom();
  }

  /**
   * What frees room is an ingest of this page's writes, which the host would
   * otherwise start only past its batch size or after its latency timer.
   */
  private askForRoom(): void {
    if (this.askingForRoom || this.roomWaiters.length === 0 || this.closed) return;
    this.askingForRoom = true;
    // A failed sync is not retried here: the waiting writes reject after ROOM_WAIT_MS.
    this.sync().then(
      () => {
        this.askingForRoom = false;
        this.admit();
      },
      () => {
        this.askingForRoom = false;
      },
    );
  }

  /** Appends `ops` as one record. Resolves once it is acked and in `own`. */
  private send(ops: readonly CheckedOp[]): Promise<void> {
    this.ensureOpen();
    const bytes = opsBytes(ops);
    this.sending += bytes;
    this.appendedRecords += 1;
    this.appendedBytes += bytes;
    const landed = this.client.append(ops).then(
      (at) => {
        this.sending -= bytes;
        this.own.add(at.log, at.n, ops);
        this.emit({ kind: "local" });
      },
      (err: unknown) => {
        this.sending -= bytes;
        this.admit();
        throw err;
      },
    );
    this.landedAll = landed.catch(noop);
    return landed;
  }

  /**
   * Runs `attempt` over the installed levels until it stops missing. While
   * it waits it holds those levels, so a generation installed meanwhile
   * cannot let the host delete the files it is reading.
   */
  private async settleInstalled<T>(attempt: (levels: readonly RunLevel[]) => Maybe<T>): Promise<T> {
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
  private readKeys(ks: readonly CheckedKey[], levels: readonly RunLevel[]): Maybe<(Uint8Array | undefined)[]> {
    const values: (Uint8Array | undefined)[] = [];
    let misses: Miss[] | undefined;
    for (const k of ks) {
      const row = this.own.get(k);
      const v = row ? valueOf(row) : pointGetSst(levels, k);
      if (v instanceof Miss) (misses ??= []).push(v);
      else values.push(v);
    }
    return misses ? allMissed(misses) : values;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    const row = this.own.get(k);
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
    await this.whenRoom(opsBytes(ops), () => this.send(ops));
  }

  update<T>(keys: readonly Uint8Array[], body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    const run = async (): Promise<T> => {
      for (;;) {
        await this.landedAll;
        // The read and the append below run in one task, so nothing of this page lands between them.
        const step = await this.whenRoom(0, async () => {
          const values = this.readKeys(ks, this.installed.levels);
          if (values instanceof Miss) return values;
          let result!: T;
          const ops = collectBatch((tx) => {
            result = body(values, tx);
            return result;
          });
          return { sent: ops.length > 0 ? this.send(ops) : Promise.resolve(), result };
        });
        if (step instanceof Miss) {
          await this.settleInstalled((levels) => this.readKeys(ks, levels));
          continue;
        }
        await step.sent;
        return step.result;
      }
    };
    const next = this.updates.then(run, run);
    this.updates = next.catch(noop);
    return next;
  }

  async rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const rows = this.own.pin();
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
      for await (const entry of scanLayers(this.own.range(bounds), layers.levels, bounds, range)) {
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
    const snap = new ViewSnapshotImpl(layers.generation, this.own.pin(), layers.levels, () => {
      this.retain(layers);
      return () => this.release(layers);
    });
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

  /** Sends what was written before the call, closes the log, and leaves the host. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.changeBus.clear();
    if (this.bus) {
      this.bus.onmessage = null;
      this.bus.close();
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
    }
    for (const waiter of this.roomWaiters.splice(0)) {
      waiter.cancel();
      waiter.fail(new ClosedError("database is closed"));
    }
    try {
      await this.client.close();
    } finally {
      this.link.close();
      this.unserve?.();
      this.release(this.installed);
    }
  }
}

function after(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}
