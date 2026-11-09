import { successor } from "./bytes.js";
import {
  checkBatch,
  checkDbName,
  checkKey,
  newWriterId,
  opsBytes,
  type CheckedKey,
  type CheckedOp,
  type DbName,
  type WriterId,
} from "./check.js";
import {
  ClosedError,
  ConstraintError,
  CorruptDatabaseError,
  StorageUnavailableError,
} from "./errors.js";
import {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
} from "./host/engine-host.js";
import { holdingFiles, layersChannel, type IngestClient } from "./host/protocol.js";
import {
  createLocalLogClient,
  createWorkerLogClient,
  republishingSegments,
  type TabLogClient,
} from "./log/client.js";
import { newTabId, type TabId } from "./log/frame.js";
import { holdTab } from "./log/liveness.js";
import type { MergedRecord } from "./log/merger.js";
import { LeftError, LogSession } from "./log/session.js";
import { pageLifecycle, type Lifecycle } from "./lifecycle.js";
import { recoverGeneration } from "./recover.js";
import { Memtable, layered, type MemRow, type MemRows } from "./store/memtable.js";
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
  /** When the page is suspended and resumed. Default: the page's own events, none without a document. */
  readonly lifecycle?: Lifecycle;
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
   * `build` runs synchronously. Promise resolves once the batch is written
   * to this tab's log; it is durable at the log's next flush. This tab reads
   * it at once. Other tabs see it once it is stable, a flush and a
   * BroadcastChannel message after the ack, or after their next `sync()`.
   * The ingest host folds the logs into OPFS runs per ingestPolicy.
   */
  batch(build: (tx: BatchTx) => void): Promise<void>;
  /**
   * Read `keys` and write at one stamp. `body` runs once, synchronously,
   * with the values of every write ordered before that stamp, in the order
   * of `keys`. Nothing can be ordered between the reads and the write, so
   * there is no conflict.
   */
  update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T>;
  /**
   * Scan `range`, then point-read `follow(entry)` for each entry that returns a
   * key, over one pin of the rows and levels. Every read sees the same state.
   */
  rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]>;
  range(range?: Range): AsyncIterable<Entry>;
  /**
   * Read-only snapshot: the stable rows, this tab's own unstable writes and
   * the installed generation, pinned when the view opens. Writes that land
   * during the callback are invisible to `snap`.
   */
  view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T>;
  /**
   * Subscribe to log appends and ingest generation bumps. Fires for this
   * tab's writes at their ack, and for other tabs' writes once stable here.
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

/** What `@opfs-lsm/kv/testing` reads from an open Db. */
export type DbInternals = {
  readonly name: DbName;
  readonly fs: CountingFs;
  readonly ingest: IngestClient;
  /** Log records and encoded op bytes this Db appended. */
  readonly appended: { records: number; bytes: number };
  /** This Db's log directory under `w/`. */
  readonly tab: TabId;
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
    ingest = createPortIngestClient(worker.port);
    ownsIngestClient = true;
  } else {
    if (!fs) fs = defaultMemoryFs(name);
    if (!ingest) ingest = localIngest(name, fs);
  }
  // Wrapped after the local host got the bare fs, so its IO counts only on the host.
  const tabFs = new CountingFs(fs);

  // This tab's own log. An fs with in-process segments (MemoryFs) writes
  // it in this thread. OPFS is written only through SyncAccessHandles,
  // which exist only in a dedicated WebWorker; it spawns while open reads
  // the logs, and the first write waits for it. A Db that rejoins after its
  // page was suspended starts a new tab, log and worker.
  const segments = fs.segments?.();
  const logClient = (tab: TabId, held: Promise<() => void>): TabLogClient => {
    if (segments) return createLocalLogClient(segments, tab, policy.maxWalBytes);
    if (typeof Worker !== "undefined") {
      // Inline URL for bundlers, as for the SharedWorker above.
      const logWorker = new Worker(new URL("./log/log-worker.js", import.meta.url), {
        type: "module",
        name: `opfs-lsm-log:${name}`,
      });
      return createWorkerLogClient(logWorker, name, tab, policy.maxWalBytes, held);
    }
    // A Node test over an fs with no in-process segments.
    if (!useBrowser) return createLocalLogClient(republishingSegments(fs), tab, policy.maxWalBytes);
    throw new StorageUnavailableError("no way to write the log: no in-process segments and no Worker");
  };
  const startTab = (): NewTab => {
    const tab = newTabId();
    // The liveness lock comes before the log directory: a tab that finds the
    // directory and not the lock takes the tab for dead.
    const held = holdTab(name, tab);
    try {
      return { tab, held, client: logClient(tab, held) };
    } catch (err) {
      void held.then((release) => release(), () => undefined);
      throw err;
    }
  };
  const first = startTab();
  const writerId = (options.writerId ?? newWriterId()) as WriterId;
  const cache = new PageCache(
    Math.max(MIN_MEMORY_BUDGET, options.memoryBudget ?? DEFAULT_BUDGET),
  );
  const appended = { records: 0, bytes: 0 };
  const db = new DbImpl(
    name,
    writerId,
    first,
    startTab,
    options.lifecycle ?? pageLifecycle(),
    tabFs,
    cache,
    ingest,
    ownsIngestClient,
    policy,
    appended,
    trace,
  );
  internals.set(db, {
    name,
    fs: tabFs,
    ingest,
    appended,
    get tab() {
      return db.tab;
    },
  });
  // Watch first: opening can already ask for an ingest of the logs it finds.
  ingest.watch(name, policy);
  const syncAt = trace ? performance.now() : 0;
  try {
    await db.open();
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
  span(trace, "sync", performance.now() - syncAt);
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
  /** The runs hold every seq <= through: every log record stamped <= cut. */
  readonly through: number;
  readonly cut: number;
  refs: number;
};

/** A tab's identity, liveness lock and log, for a Db to join the tabs as. */
type NewTab = { readonly tab: TabId; readonly held: Promise<() => void>; readonly client: TabLogClient };

/** Runs opened at once while loading a generation. */
const OPEN_CONCURRENCY = 16;

/** What DbImpl hears on `layersChannel` itself; the log protocol is the session's. */
type BusMessage = {
  readonly kind: string;
  readonly writerId?: string;
  /** For `ingest`: the generation published. */
  readonly generation?: number;
};

/** Tries under the reclaim lock: each failure means files really are gone. */
const GENERATION_RETRIES = 8;
const GENERATION_GONE =
  "SST files for the committed generation stayed missing after retries";

/**
 * Reads come from this tab's own unstable writes over its memtable over
 * the installed SST generation, and never leave the thread. The memtable
 * is the stable prefix of every tab's log, numbered on from the
 * generation's `through`; every tab numbers it the same way, so every read
 * sees the state after one prefix of the one order, plus this tab's own
 * newer writes (architecture/wal-opfs/04-per-tab-logs.md).
 */
class DbImpl implements Db {
  private closed = false;
  private readonly mem = new Memtable();
  private session: LogSession;
  /** Tabs this Db was before it rejoined: their records are its own writes. */
  private readonly formerTabs = new Set<TabId>();
  /**
   * Set from a suspend until this Db rejoined as a new tab. Work that needs
   * the session waits for `back`, which rejects if the rejoin failed.
   */
  private away: { back: Promise<void>; open: () => void; fail: (err: unknown) => void } | undefined;
  /** The page is suspended now. */
  private suspended = false;
  private rejoining: Promise<void> = Promise.resolve();
  private stopWatching: (() => void) | undefined;
  private installed: Layers = {
    generation: 0,
    runs: [],
    levels: [],
    tombstoneSeq: 0,
    through: 0,
    cut: 0,
    refs: 1,
  };
  /** The newest generation loaded and not yet installed. */
  private loaded: Layers | undefined;
  /** The newest generation a hint named. */
  private wantGeneration = 0;
  /** Open runs of every held generation by path. Paths are immutable, so a hit never goes stale. */
  private readonly runs = new Map<string, Run>();
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private readonly changeBus = new ChangeBus();
  private bus: BroadcastChannel | undefined;

  constructor(
    readonly name: DbName,
    readonly writerId: WriterId,
    first: NewTab,
    private readonly startTab: () => NewTab,
    private readonly lifecycle: Lifecycle | undefined,
    private readonly fs: AsyncFs,
    private readonly cache: PageCache,
    private readonly ingestClient: IngestClient,
    private readonly ownsIngestClient: boolean,
    private readonly policy: IngestPolicy,
    private readonly appended: { records: number; bytes: number },
    private readonly trace?: OpenTrace,
  ) {
    this.session = this.startSession(first);
    this.openBus();
  }

  private openBus(): void {
    if (typeof BroadcastChannel === "undefined") return;
    this.bus = new BroadcastChannel(layersChannel(this.name));
    this.bus.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
  }

  private closeBus(): void {
    this.bus?.close();
    this.bus = undefined;
  }

  get tab(): TabId {
    return this.session.tab;
  }

  private startSession({ tab, held, client }: NewTab, after?: LogSession): LogSession {
    return new LogSession({
      name: this.name,
      tab,
      held,
      fs: this.fs,
      client,
      maxWalBytes: this.policy.maxWalBytes,
      onStable: (records) => this.applyStable(records),
      onBehind: (through) =>
        void this.syncGeneration().then(
          () => {
            if (!this.closed && this.installed.cut < through) {
              this.session.corrupt(
                new CorruptDatabaseError(`log records through stamp ${through} were reclaimed, and no generation holds them`),
              );
            }
          },
          () => undefined,
        ),
      onGone: () => this.syncGeneration(),
      ...(after ? { after } : {}),
    });
  }

  /**
   * A frozen page answers no other tab, and every tab waits for every live
   * one. So this tab leaves while the page still runs, as a close does, and
   * the others read its log to its end.
   */
  private suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    if (!this.away) {
      let open!: () => void;
      let fail!: (err: unknown) => void;
      const back = new Promise<void>((res, rej) => {
        open = res;
        fail = rej;
      });
      back.catch(() => undefined);
      this.away = { back, open, fail };
    }
    // Chrome evicts a page from the back/forward cache when a message reaches it.
    this.closeBus();
    void this.session.leave();
  }

  private resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.rejoining = this.rejoining.then(() => this.rejoin());
  }

  /**
   * Join again as a new tab: a tab never reopens its log. Every tab reads
   * the old tab's log to its end, this one too, so its records take their
   * place in the order like any tab's. The new session starts above what
   * the old one handed out, and reads the old one's unstable records
   * through its overlay until they become stable. Generations published
   * while away went unheard, so the newest is installed first, as on open.
   */
  private async rejoin(): Promise<void> {
    const away = this.away;
    if (!away || this.suspended || this.closed) return;
    const old = this.session;
    await old.leave();
    if (this.suspended || this.closed) return;
    try {
      const next = this.startSession(this.startTab(), old);
      this.formerTabs.add(old.tab);
      this.session = next;
      this.openBus();
      await this.syncGeneration();
      await next.prepareJoin();
      await next.finishJoin();
      await next.waitStable(next.merger.maxSeen());
    } catch (err) {
      // Suspended or closed again: the next resume rejoins, or close fails the waiters.
      if (err instanceof LeftError || this.closed) return;
      away.fail(err);
      return;
    }
    if (this.suspended) return;
    this.away = undefined;
    away.open();
  }

  /**
   * Run `fn` on the session, once this Db is back if the page is suspended.
   * A session that left throws `LeftError` only before it wrote anything,
   * so `fn` runs again on the next one.
   */
  private async onSession<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      // No await when not away: a write started before `close` must reach the log before it.
      if (this.away) await this.away.back;
      this.ensureOpen();
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof LeftError)) throw err;
      }
    }
  }

  /**
   * Join the tabs and catch up. Reading the logs and taking the liveness
   * lock need no generation, so they run while it loads; records are handed
   * out only once it is installed, numbered on from its `through`. The bus
   * is already live, so a generation published meanwhile is announced here
   * and loaded on top.
   */
  async open(): Promise<void> {
    const at = this.trace ? performance.now() : 0;
    // The newest manifest, whose cut lets the log reads pass over what it
    // holds. The reads start at once and wait for the cut only to scan.
    const recovering = recoverGeneration(this.fs, () => true);
    const preparing = this.session
      .prepareJoin(recovering.then((r) => r.meta.cut, () => 0))
      .then(() => span(this.trace, "join", performance.now() - at));
    try {
      const { meta } = await recovering;
      this.wantGeneration = meta.generation;
      await this.syncGeneration();
      span(this.trace, "generation", performance.now() - at);
      await preparing;
      // A run of that manifest was gone and an older generation stands in:
      // read the logs again above its lower cut.
      if (this.installed.cut < meta.cut) await this.session.rejoin(this.installed.cut);
    } finally {
      await preparing.catch(() => undefined);
    }
    const logAt = this.trace ? performance.now() : 0;
    await this.session.finishJoin();
    await this.session.waitStable(this.session.merger.maxSeen());
    span(this.trace, "log", performance.now() - logAt);
    this.stopWatching = this.lifecycle?.({ suspend: () => this.suspend(), resume: () => this.resume() });
  }

  private onMessage(data: BusMessage | null): void {
    if (this.closed || !data || data.kind !== "ingest" || data.writerId === this.writerId) return;
    this.wantGeneration = Math.max(this.wantGeneration, data.generation ?? 0);
    void this.syncGeneration().catch(() => undefined);
    this.changeBus.emit({ kind: "ingest", writerId: data.writerId ?? "" });
  }

  /**
   * Number stable records on from the memtable and apply them, then tell
   * listeners. This tab's own records were announced at their ack; the
   * seq of one that became stable before it is kept for that event.
   */
  private applyStable(records: readonly MergedRecord[]): void {
    for (const r of records) {
      const seq = this.mem.appliedThrough + 1;
      this.mem.apply({ seq, ops: r.ops });
      if (r.tab !== this.session.tab && !this.formerTabs.has(r.tab)) {
        this.changeBus.emit({ kind: "append", writerId: r.writerId, seq });
      } else if (this.acking.has(r.stamp)) {
        this.acking.set(r.stamp, seq);
      }
    }
  }

  /** This tab's appends between write and ack, by stamp: their seq once stable. */
  private readonly acking = new Map<number, number | undefined>();

  /** Announce this tab's own write at its ack, with its seq when it is already stable. */
  private acked(stamp: number): void {
    const seq = this.acking.get(stamp);
    this.acking.delete(stamp);
    this.emitChange({ kind: "append", writerId: this.writerId, ...(seq !== undefined ? { seq } : {}) });
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

  /** This tab's unstable writes over the memtable. */
  private rows(): MemRows {
    const own = this.session.ownRows;
    return own ? layered(own, this.mem) : this.mem;
  }

  private pinRows(): MemRows {
    const own = this.session.pinOwnRows();
    return own ? layered(own, this.mem.pin()) : this.mem.pin();
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
      through: meta.through,
      cut: meta.cut,
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
   * Make the loaded generation the installed one, if it is newer. The
   * memtable drops what it covers and jumps to its `through`, and the
   * session to its cut. Synchronous, so reads never see half a switch.
   */
  private installLoaded(): void {
    const layers = this.loaded;
    this.loaded = undefined;
    if (!layers) return;
    if (layers.generation <= this.installed.generation) {
      this.release(layers);
      return;
    }
    this.release(this.installed);
    this.installed = layers;
    this.mem.advanceTo(layers.through);
    this.session.cut(layers.cut);
  }

  /**
   * The newest generation: the one a hint named, or the newest manifest.
   * `checked` looks past a manifest whose runs are gone to the newest
   * intact one (`recoverGeneration`); only the retries ask for it, under
   * the reclaim lock, where a missing run means it never reached the disk.
   */
  private async newestGeneration(checked: boolean): Promise<number> {
    if (checked) {
      const installed = this.installed.generation;
      return (await recoverGeneration(this.fs, (g) => g === installed)).meta.generation;
    }
    if (this.wantGeneration > this.installed.generation) return this.wantGeneration;
    return (await recoverGeneration(this.fs, () => true)).meta.generation;
  }

  /**
   * Load and install the newest generation. Usually without the reclaim
   * lock. A run or manifest that went missing mid-load was almost always
   * reclaimed after a newer generation replaced it, and under churn that
   * can repeat on every try. So the retries hold the reclaim lock shared:
   * the host removes no file until they return (design.md, "Loading a
   * generation under churn").
   */
  private async syncGeneration(): Promise<void> {
    if (await this.loadNewest()) return;
    await holdingFiles(this.name, async () => {
      for (let gone = 0; !(await this.loadNewest(true)); gone++) {
        if (gone + 1 >= GENERATION_RETRIES) throw new CorruptDatabaseError(GENERATION_GONE);
        this.wantGeneration = 0;
      }
    });
  }

  /** True once the newest generation is installed, false when one of its files was gone. */
  private async loadNewest(checked = false): Promise<boolean> {
    const sstAt = this.trace ? performance.now() : 0;
    const generation = await this.newestGeneration(checked);
    if (generation <= this.installed.generation) return true;
    const whole = await this.load(generation);
    if (this.closed) return true;
    if (whole) this.installLoaded();
    if (this.trace) span(this.trace, "sst", performance.now() - sstAt);
    return whole;
  }

  /**
   * Catch up to everything acked before the call, from any tab, and
   * install the newest generation. Reads after it resolves see other tabs'
   * acked writes.
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
          await this.syncGeneration();
          if (this.closed) return;
          const logAt = this.trace ? performance.now() : 0;
          await this.onSession(() => this.session.catchUp());
          span(this.trace, "log", performance.now() - logAt);
        } while (this.syncAgain);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
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

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    const row = this.rows().get(k);
    if (row) return valueOf(row);
    return this.settleInstalled((levels) => pointGetSst(levels, k));
  }

  put(key: Uint8Array, value: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.put(key, value));
  }

  delete(key: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.delete(key));
  }

  private count(ops: readonly CheckedOp[]): void {
    this.appended.records += 1;
    this.appended.bytes += opsBytes(ops);
  }

  async batch(build: (tx: BatchTx) => void): Promise<void> {
    this.ensureOpen();
    const ops = collectBatch(build);
    if (ops.length === 0) return;
    const stamp = await this.onSession(async () => {
      let at: number | undefined;
      try {
        return await this.session.append(ops, this.writerId, (s) => this.acking.set((at = s), undefined));
      } catch (err) {
        if (at !== undefined) this.acking.delete(at);
        throw err;
      }
    });
    this.acked(stamp);
    this.count(ops);
  }

  /**
   * Hold the next stamp, wait until everything ordered before it is
   * stable here, read, and write at that stamp. Nothing ordered after it
   * becomes visible meanwhile, so the read is exactly the state the write
   * lands on: no conflict, no retry, and `body` runs once.
   */
  async update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    const held = await this.onSession(() => this.session.reserve());
    const layers = this.installed;
    this.retain(layers);
    try {
      // Usually every key is in memory or a cached block: read now, and pin
      // the rows only when a read has to wait for the disk.
      const now = this.readKeys(ks, this.rows(), layers.levels);
      let values: (Uint8Array | undefined)[];
      if (now instanceof Miss) {
        const rows = this.pinRows();
        values = await settle(() => this.readKeys(ks, rows, layers.levels));
      } else {
        values = now;
      }
      let result!: T;
      const ops = collectBatch((tx) => {
        result = body(values, tx);
        return result;
      });
      if (ops.length > 0) {
        this.acking.set(held.stamp, undefined);
        await held.commit(ops, this.writerId);
        this.acked(held.stamp);
        this.count(ops);
      }
      return result;
    } finally {
      held.done();
      this.release(layers);
    }
  }

  /** Every key read, or one Miss for all the bytes they lack. */
  private readKeys(
    ks: readonly CheckedKey[],
    rows: MemRows,
    levels: readonly RunLevel[],
  ): Maybe<(Uint8Array | undefined)[]> {
    const values: (Uint8Array | undefined)[] = [];
    let misses: Miss[] | undefined;
    for (const k of ks) {
      const row = rows.get(k);
      const v = row ? valueOf(row) : pointGetSst(levels, k);
      if (v instanceof Miss) (misses ??= []).push(v);
      else values.push(v);
    }
    return misses ? allMissed(misses) : values;
  }

  async rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const rows = this.pinRows();
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
      for await (const entry of scanLayers(this.rows().range(bounds), layers.levels, bounds, range)) {
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
      this.pinRows(),
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

  /** Fold everything acked so far, by any tab, into the SSTs, and wait for compaction. */
  async ingest(): Promise<{ generation: number }> {
    this.ensureOpen();
    const cut = await this.onSession(() => this.session.stableCut());
    const before = this.installed.generation;
    const result = await this.ingestClient.ingest(this.name, cut, true);
    if (result.generation !== before) {
      this.emitChange({ kind: "ingest", writerId: this.writerId });
      this.broadcast({ kind: "ingest", writerId: this.writerId, generation: result.generation });
    }
    this.wantGeneration = Math.max(this.wantGeneration, result.generation);
    await this.sync();
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.changeBus.clear();
    this.stopWatching?.();
    this.away?.fail(new ClosedError("database is closed"));
    this.closeBus();
    this.ingestClient.unwatch(this.name);
    if (this.ownsIngestClient) this.ingestClient.close();
    await this.session.close();
    this.release(this.installed);
    if (this.loaded) this.release(this.loaded);
    this.loaded = undefined;
  }
}
