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
  ConstraintError,
  CorruptDatabaseError,
  StorageUnavailableError,
} from "./errors.js";
import { runTransaction, type Transaction } from "./transaction.js";
import {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
} from "./host/engine-host.js";
import type { IngestClient } from "./host/protocol.js";
import { IdBWal, type MemRow } from "./idb/wal.js";
import type { ScanBounds } from "./store/cursor.js";
import {
  DEFAULT_INGEST_POLICY,
  IngestScheduler,
  measureOpBytes,
  type IngestPolicy,
} from "./ingest-policy.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import { openBrowserFs } from "./opfs/browser-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";
import {
  loadLatestGeneration,
  loadRuns,
  loadSstReader,
} from "./store/generation.js";
import {
  arrayCursor,
  mergeCursors,
  pointGetSst,
} from "./store/merge.js";
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
  /** Background WAL→OPFS ingest policy. */
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
   * commit. Other tabs see the write on their next get; OPFS update is
   * scheduled per ingestPolicy.
   */
  batch(build: (tx: BatchTx) => void): Promise<void>;
  /**
   * Interactive transaction: snapshot + write buffer + key-based OCC.
   * Concurrent WAL writes that touch a read/written key cause ConflictError.
   */
  transaction<T>(body: (tx: Transaction) => Promise<T> | T): Promise<T>;
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
  /** Force ingest now (awaits host). */
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
  return db;
}

type Layers = {
  readonly generation: number;
  readonly readers: readonly SstReader[];
};

const GENERATION_RETRIES = 8;
const GENERATION_GONE =
  "SST files for the recorded generation stayed missing after retries";

class DbImpl implements Db {
  private closed = false;
  private readonly scheduler: IngestScheduler<{ generation: number }>;
  /** The newest generation loaded. Not a key map. */
  private installed: Layers | undefined;
  /** Parsed run files by path. Paths are immutable, so a hit never goes stale. */
  private runs = new Map<string, SstReader>();
  private readonly changeBus = new ChangeBus();
  private readonly bus: BroadcastChannel | undefined;
  private readonly onBusMessage: ((ev: MessageEvent) => void) | undefined;

  constructor(
    readonly name: DbName,
    readonly writerId: WriterId,
    private readonly wal: IdBWal,
    private readonly fs: AsyncFs,
    private readonly ingestClient: IngestClient,
    policy: IngestPolicy,
    private readonly ownsIngestClient: boolean,
  ) {
    this.scheduler = new IngestScheduler(policy, async () => {
      const result = await this.ingestClient.ingest(this.name);
      this.emitChange({ kind: "ingest", writerId: this.writerId });
      this.broadcast("ingest");
      return result;
    });
    if (typeof BroadcastChannel !== "undefined") {
      this.bus = new BroadcastChannel(`opfs-lsm-layers/${name}`);
      this.onBusMessage = (ev: MessageEvent) => {
        const data = ev.data as {
          kind?: "append" | "ingest";
          writerId?: string;
          seq?: number;
        } | null;
        if (!data || data.writerId === this.writerId) return;
        if (data.kind === "append" || data.kind === "ingest") {
          this.changeBus.emit({
            kind: data.kind,
            writerId: data.writerId ?? "unknown",
            ...(data.seq !== undefined ? { seq: data.seq } : {}),
          });
        }
      };
      this.bus.addEventListener("message", this.onBusMessage);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("database is closed");
  }

  private broadcast(
    kind: "append" | "ingest",
    extra?: { seq?: number },
  ): void {
    this.bus?.postMessage({
      kind,
      writerId: this.writerId,
      ...extra,
    });
  }

  private emitChange(event: ChangeEvent): void {
    this.changeBus.emit(event);
  }

  /**
   * Readers for exactly `generation`, or, with `newerOk`, for a newer loaded
   * one. Newer is safe for a point read: it returns a newer acked value. A
   * scan needs exactly the pinned generation, or it can see half of a batch
   * that landed after its mem pin. Undefined when a newer publish already
   * removed the files.
   */
  private async layersAt(
    generation: number,
    newerOk: boolean,
  ): Promise<Layers | undefined> {
    const installed = this.installed;
    if (
      installed &&
      (installed.generation === generation ||
        (newerOk && installed.generation > generation))
    ) {
      return installed;
    }
    const paths = await loadRuns(this.fs, generation);
    if (!paths) return undefined;
    const readers: SstReader[] = [];
    for (const path of paths) {
      const reader = this.runs.get(path) ?? (await loadSstReader(this.fs, path));
      if (!reader) return undefined;
      readers.push(reader);
    }
    const layers = { generation, readers };
    const latest = this.installed;
    if (!latest || latest.generation < generation) {
      this.installed = layers;
      this.runs = new Map(paths.map((path, i) => [path, readers[i]!]));
      return layers;
    }
    return newerOk ? latest : layers;
  }

  private async openScan(bounds?: ScanBounds): Promise<{
    head: number;
    rows: readonly MemRow[];
  } & Layers> {
    for (let attempt = 0; attempt < GENERATION_RETRIES; attempt++) {
      const pin = await this.wal.collectMem(bounds);
      const layers = await this.layersAt(pin.generation, false);
      if (layers) return { head: pin.head, rows: pin.rows, ...layers };
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    return this.readKey(checkKey(key));
  }

  private async readKey(k: CheckedKey): Promise<Uint8Array | undefined> {
    for (let attempt = 0; attempt < GENERATION_RETRIES; attempt++) {
      const { row, generation } = await this.wal.memGet(k);
      if (row?.kind === "del") return undefined;
      if (row?.kind === "put") return new Uint8Array(row.value!);
      const layers = await this.layersAt(generation, true);
      if (layers) return pointGetSst(layers.readers, k);
    }
    throw new CorruptDatabaseError(GENERATION_GONE);
  }

  put(key: Uint8Array, value: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.put(key, value));
  }

  delete(key: Uint8Array): Promise<void> {
    return this.batch((tx) => tx.delete(key));
  }

  async batch(build: (tx: BatchTx) => void): Promise<void> {
    this.ensureOpen();
    const ops: { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }[] =
      [];
    const tx: BatchTx = {
      put: (key, value) => {
        ops.push({ type: "put", key, value });
      },
      delete: (key) => {
        ops.push({ type: "del", key });
      },
    };
    const ret = build(tx) as unknown;
    if (
      ret !== undefined &&
      ret !== null &&
      typeof (ret as { then?: unknown }).then === "function"
    ) {
      throw new ConstraintError("batch callback must not return a thenable");
    }
    const checked = checkBatch(ops);
    if (checked.length === 0) return;
    const seq = await this.wal.append(checked as CheckedOp[]);
    this.emitChange({ kind: "append", writerId: this.writerId, seq });
    this.broadcast("append", { seq });
    this.scheduler.noteAppend(measureOpBytes(checked));
  }

  transaction<T>(body: (tx: Transaction) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    return runTransaction(
      {
        snapshotHead: () => this.wal.snapshotHead(),
        get: (key) => this.readKey(key),
        commit: async (ops, opBytes, guard) => {
          const seq = await this.wal.append(ops, guard);
          this.emitChange({ kind: "append", writerId: this.writerId, seq });
          this.broadcast("append", { seq });
          this.scheduler.noteAppend(opBytes);
        },
      },
      body,
    );
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const scan = await this.openScan(bounds);
    yield* mergeCursors(
      [
        arrayCursor(scan.rows),
        ...scan.readers.map((reader) => reader.cursor(bounds)),
      ],
      range?.limit,
    );
  }

  async view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const scan = await this.openScan();
    const snap = new ViewSnapshotImpl(
      scan.head,
      scan.generation,
      scan.rows,
      scan.readers,
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
    return this.scheduler.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.close();
    this.changeBus.clear();
    this.installed = undefined;
    this.runs.clear();
    if (this.bus && this.onBusMessage) {
      this.bus.removeEventListener("message", this.onBusMessage);
      this.bus.close();
    }
    if (this.ownsIngestClient) this.ingestClient.close();
    this.wal.close();
  }
}
