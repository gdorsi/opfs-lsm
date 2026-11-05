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
} from "./host/engine-host.js";
import { layersChannel, type IngestClient } from "./host/protocol.js";
import { IdBWal, type WalTail } from "./idb/wal.js";
import { Memtable, type MemRow, type WalRecord } from "./store/memtable.js";
import type { ScanBounds } from "./store/cursor.js";
import { DEFAULT_INGEST_POLICY, type IngestPolicy } from "./ingest-policy.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import { openBrowserFs } from "./opfs/browser-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";
import {
  loadGeneration,
  loadLatestGeneration,
  loadSstReader,
} from "./store/generation.js";
import {
  arrayCursor,
  mergeCursors,
  pointGetSst,
  runLevels,
  type RunLevel,
} from "./store/merge.js";
import { ensureEngine } from "./store/engine.js";
import type { SstReader } from "./store/sst.js";
import {
  ViewSnapshotImpl,
  boundsOf,
  type ViewSnapshot,
} from "./view.js";
import {
  ChangeBus,
  type ChangeEvent,
  type ChangeListener,
} from "./changes.js";

export type { ViewSnapshot } from "./view.js";
export type { ChangeEvent, ChangeListener, ChangeKind } from "./changes.js";

export type OpenOptions = {
  readonly name: string;
  /**
   * SST/generation filesystem used for **reads** on this tab.
   * Must match what the ingest host publishes to.
   * Omit in the browser to use OPFS when SharedWorker and
   * navigator.storage.getDirectory exist. Omit in Node to use MemoryFs.
   */
  readonly fs?: AsyncFs;
  /**
   * Ingest client. Omit in the browser when `workerUrl` is set (SharedWorker).
   * Omit in Node/tests for an in-process EngineHost.
   */
  readonly ingest?: IngestClient;
  /**
   * SharedWorker script URL for browser default wiring.
   * Example: `new URL("@opfs-lsm/kv/shared-worker", import.meta.url)`
   */
  readonly workerUrl?: string | URL;
  /** Stable writer id (tests / debugging). Default: random UUID. */
  readonly writerId?: string;
  /** When the memtable flushes to an OPFS run. */
  readonly ingestPolicy?: Partial<IngestPolicy>;
  /**
   * Force the Node/test path (MemoryFs + local host) even in a browser.
   * Useful for unit tests under jsdom.
   */
  readonly forceMemory?: boolean;
  /**
   * Use MemoryFs when this page has no SharedWorker or OPFS.
   * Data lives only until the page closes. Ignored when OPFS can open,
   * and ignored in Node, which already defaults to MemoryFs.
   */
  readonly allowEphemeral?: boolean;
};

export type Range = {
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
  readonly limit?: number;
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
   * commit. Other tabs see the write on their next get. The memtable flushes
   * to OPFS per ingestPolicy.
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
  const name = checkDbName(options.name);
  // Reads unpack LZ4 blocks faster once wasm loads. Until then they use the JS decoder.
  void ensureEngine();
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
      "browser openDb needs SharedWorker and navigator.storage.getDirectory. Pass allowEphemeral: true to keep data in memory for this page only, or pass fs, ingest, or forceMemory.",
    );
  }

  if (useBrowser) {
    if (!options.workerUrl) {
      throw new ConstraintError(
        'browser openDb requires workerUrl (SharedWorker module URL), e.g. new URL("@opfs-lsm/kv/shared-worker", import.meta.url)',
      );
    }
    fs = await openBrowserFs(name);
    const worker = new SharedWorker(options.workerUrl, {
      type: "module",
      name: `opfs-lsm:${name}`,
    });
    ingest = createPortIngestClient(worker.port);
    ownsIngestClient = true;
  } else {
    if (!fs) fs = defaultMemoryFs(name);
    if (!ingest) ingest = localIngest(name, fs);
  }

  const wal = await IdBWal.open(name);
  if ((await wal.recordedGeneration()) === undefined) {
    await wal.raiseGeneration((await loadLatestGeneration(fs))?.generation ?? 0);
  }
  const writerId = (options.writerId ?? newWriterId()) as WriterId;
  const db = new DbImpl(
    name,
    writerId,
    wal,
    fs,
    ingest,
    policy,
    ownsIngestClient,
  );
  await db.sync();
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

type Layers = {
  readonly generation: number;
  readonly paths: readonly string[];
  readonly readers: readonly SstReader[];
  /** The readers as scan sources, newest first. */
  readonly levels: readonly RunLevel[];
  readonly tombstoneSeq: number;
};

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
  private flushing: Promise<unknown> = Promise.resolve();
  private readonly mem = new Memtable();
  private installed: Layers = {
    generation: 0,
    paths: [],
    readers: [],
    levels: [],
    tombstoneSeq: 0,
  };
  /** The newest generation loaded and not yet installed. */
  private loaded: Layers | undefined;
  /** Parsed run files by path. Paths are immutable, so a hit never goes stale. */
  private runs = new Map<string, SstReader>();
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
    private readonly ingestClient: IngestClient,
    private readonly policy: IngestPolicy,
    private readonly ownsIngestClient: boolean,
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
      if (!this.apply({ seq: data.seq, ops: data.ops })) {
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
    this.bus?.postMessage(message);
  }

  private emitChange(event: ChangeEvent): void {
    this.changeBus.emit(event);
  }

  /** Ask the ingest host to flush every record through `through`. */
  private flush(
    through: number,
    settle = false,
  ): Promise<{ generation: number }> {
    const before = this.installed.generation;
    const run = this.flushing
      .catch(() => undefined)
      .then(async () => {
        const result = await this.ingestClient.ingest(
          this.name,
          through,
          settle,
        );
        if (result.generation !== before) {
          this.emitChange({ kind: "ingest", writerId: this.writerId });
          this.broadcast({ kind: "ingest", writerId: this.writerId });
        }
        void this.sync().catch(() => undefined);
        return result;
      });
    this.flushing = run;
    return run;
  }

  /**
   * Apply `record` to the memtable. The record that takes the waiting WAL
   * bytes past a multiple of the limit is the same in every tab, so each tab
   * asks for the same flush and the host runs it once. Later multiples retry
   * a flush that failed.
   */
  private apply(record: WalRecord): boolean {
    const was = { seq: this.mem.appliedThrough, walBytes: this.mem.walBytes };
    if (!this.mem.apply(record)) return false;
    if (this.mem.appliedThrough === was.seq || this.closed) return true;
    const { maxWalBytes } = this.policy;
    if (Math.floor(this.mem.walBytes / maxWalBytes) > Math.floor(was.walBytes / maxWalBytes)) {
      void this.flush(record.seq).catch(() => undefined);
    }
    return true;
  }

  /** Readers for exactly `generation`, loading them when needed. */
  private async load(generation: number): Promise<Layers | undefined> {
    for (const layers of [this.installed, this.loaded]) {
      if (layers?.generation === generation) return layers;
    }
    const meta = await loadGeneration(this.fs, generation);
    if (!meta) return undefined;
    const readers: SstReader[] = [];
    for (const { path } of meta.runs) {
      const reader = this.runs.get(path) ?? (await loadSstReader(this.fs, path));
      if (!reader) return undefined;
      readers.push(reader);
    }
    const paths = meta.runs.map((r) => r.path);
    const layers = {
      generation,
      paths,
      readers,
      levels: runLevels(paths, readers),
      tombstoneSeq: meta.tombstoneSeq,
    };
    if (!this.loaded || this.loaded.generation < generation) {
      this.loaded = layers;
    }
    return layers;
  }

  /**
   * Apply `tail` to the memtable. Synchronous, so it can run inside an
   * IndexedDB transaction. Returns the generation to load when the tail
   * needs one this tab does not have yet.
   */
  private catchUp(tail: WalTail): number | undefined {
    const behind = tail.ingestedThrough > this.mem.appliedThrough;
    if (tail.generation !== this.installed.generation) {
      const layers =
        this.loaded?.generation === tail.generation ? this.loaded : undefined;
      if (layers) {
        this.installed = layers;
        this.loaded = undefined;
        this.runs = new Map(
          layers.paths.map((path, i) => [path, layers.readers[i]!]),
        );
      } else if (behind) {
        return tail.generation;
      }
    }
    if (this.installed.generation === tail.generation) {
      this.mem.advanceTo(tail.ingestedThrough);
    }
    for (const record of tail.records) {
      if (!this.apply(record)) {
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
      const tail = await this.wal.tail(this.mem.appliedThrough);
      if (this.closed) return;
      if (tail.generation !== this.installed.generation) {
        await this.load(tail.generation);
      }
      if (this.catchUp(tail) === undefined) return;
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
  }

  /**
   * In one readwrite transaction, catch the memtable up, let `plan` choose a
   * batch against it, and append. The batch joins the memtable at its seq,
   * so this tab reads its own write as soon as the ack resolves.
   */
  private async write<R>(
    plan: () => { readonly ops: readonly CheckedOp[]; readonly result: R },
  ): Promise<R> {
    for (let attempt = 0; attempt < GENERATION_RETRIES; attempt++) {
      let missing: number | undefined;
      const out = await this.wal.appendAfter(this.mem.appliedThrough, (tail) => {
        missing = this.catchUp(tail);
        return missing === undefined ? plan() : undefined;
      });
      if (out) {
        if (out.seq !== undefined) {
          if (!this.apply({ seq: out.seq, ops: out.ops })) await this.sync();
          this.emitChange({ kind: "append", writerId: this.writerId, seq: out.seq });
          this.broadcast({
            kind: "append",
            writerId: this.writerId,
            seq: out.seq,
            ops: out.ops,
          });
        }
        return out.result;
      }
      if (missing !== undefined) await this.load(missing);
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
  }

  private readKey(k: CheckedKey): Uint8Array | undefined {
    const row = this.mem.get(k);
    return row ? valueOf(row) : pointGetSst(this.installed.levels, k);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    return this.readKey(checkKey(key));
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
    await this.write(() => ({ ops, result: undefined }));
  }

  update<T>(
    keys: readonly Uint8Array[],
    body: (values: readonly (Uint8Array | undefined)[], tx: BatchTx) => T,
  ): Promise<T> {
    this.ensureOpen();
    const ks = keys.map(checkKey);
    return this.write(() => {
      const values = ks.map((k) => this.readKey(k));
      let result!: T;
      const ops = collectBatch((tx) => {
        result = body(values, tx);
        return result;
      });
      return { ops, result };
    });
  }

  async rangeFollow(
    range: Range,
    follow: (entry: Entry) => Uint8Array | undefined,
  ): Promise<{ readonly entry: Entry; readonly value: Uint8Array | undefined }[]> {
    this.ensureOpen();
    const out: { entry: Entry; value: Uint8Array | undefined }[] = [];
    for (const entry of this.scan(range)) {
      const key = follow(entry);
      out.push({
        entry,
        value: key === undefined ? undefined : this.readKey(checkKey(key)),
      });
    }
    return out;
  }

  private scan(range?: Range): Generator<Entry> {
    const bounds = boundsOf(range);
    return mergeCursors(
      [
        arrayCursor(this.mem.range(bounds)),
        ...this.installed.levels.map((level) => level.cursor(bounds)),
      ],
      range?.limit,
    );
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    for (const entry of this.scan(range)) {
      this.ensureOpen();
      yield entry;
    }
  }

  async view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const snap = new ViewSnapshotImpl(
      this.mem.appliedThrough,
      this.installed.generation,
      this.mem.pin(),
      this.installed.levels,
    );
    try {
      return await body(snap);
    } finally {
      snap.close();
    }
  }

  changes(listener: ChangeListener): () => void {
    this.ensureOpen();
    return this.changeBus.subscribe(listener);
  }

  async ingest(): Promise<{ generation: number }> {
    this.ensureOpen();
    const result = await this.flush(Number.POSITIVE_INFINITY, true);
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
    if (this.ownsIngestClient) this.ingestClient.close();
    this.wal.close();
  }
}
