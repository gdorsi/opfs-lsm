import { successor } from "./bytes.js";
import {
  checkBatch,
  checkDbName,
  checkKey,
  newWriterId,
  type CheckedOp,
  type DbName,
  type WriterId,
} from "./check.js";
import { ClosedError, ConstraintError } from "./errors.js";
import { runTransaction, type Transaction } from "./transaction.js";
import {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
} from "./host/engine-host.js";
import type { IngestClient } from "./host/protocol.js";
import { IdBWal } from "./idb/wal.js";
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
  loadSstLayer,
} from "./store/generation.js";
import { KeyOverlay, resolveGet } from "./store/overlay.js";
import { SstLayer } from "./store/sst-layer.js";
import {
  ViewSnapshotImpl,
  mergePuts,
  type PutEntry,
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
   * Omit in the browser to use OPFS; omit in Node/tests to use MemoryFs.
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

  const useBrowser =
    !options.forceMemory && !fs && !ingest && canUseBrowserOpfs();

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
  const writerId = (options.writerId ?? newWriterId()) as WriterId;
  return new DbImpl(name, writerId, wal, fs, ingest, policy, ownsIngestClient);
}

class DbImpl implements Db {
  private closed = false;
  private readonly scheduler: IngestScheduler<{ generation: number }>;
  private walCache:
    | { ingested: number; head: number; overlay: KeyOverlay }
    | undefined;
  private sstCache: { generation: number; layer: SstLayer } | undefined;
  /** Merged WAL-over-SST puts; rebuilt when layers change. */
  private sortedPuts: PutEntry[] | undefined;
  /** When true, next read revalidates against IDB/FS (cross-tab / ingest). */
  private layersStale = true;
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
      this.invalidateCaches();
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
        this.layersStale = true;
        this.sortedPuts = undefined;
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

  private invalidateCaches(): void {
    this.walCache = undefined;
    this.sstCache = undefined;
    this.sortedPuts = undefined;
    this.layersStale = true;
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

  private noteLocalAppend(ops: readonly CheckedOp[], seq: number): void {
    if (this.walCache && this.walCache.head === seq - 1) {
      this.walCache.overlay.applyOps(ops);
      this.walCache.head = seq;
      this.sortedPuts = undefined;
    } else {
      // Gap vs cache — force a full WAL rebuild on next read.
      this.walCache = undefined;
      this.sortedPuts = undefined;
      this.layersStale = true;
    }
    this.emitChange({ kind: "append", writerId: this.writerId, seq });
    this.broadcast("append", { seq });
  }

  /**
   * Hot path: serve cached WAL/SST overlays without IDB/FS.
   * Rebuild when cold, after ingest, or when another tab signals a write.
   */
  private async readLayers(): Promise<{
    wal: KeyOverlay;
    sst: SstLayer;
  }> {
    if (this.walCache && this.sstCache && !this.layersStale) {
      return { wal: this.walCache.overlay, sst: this.sstCache.layer };
    }

    const ingested = await this.wal.getIngestedThrough();
    const head = await this.wal.headSeq();
    if (
      !this.walCache ||
      this.walCache.ingested !== ingested ||
      this.walCache.head !== head
    ) {
      const overlay = new KeyOverlay();
      if (ingested < head) {
        overlay.applyRecords(await this.wal.listRange(ingested + 1, head));
      }
      this.walCache = { ingested, head, overlay };
    }

    const gen = await loadLatestGeneration(this.fs);
    const generation = gen?.generation ?? 0;
    if (!this.sstCache || this.sstCache.generation !== generation) {
      this.sstCache = {
        generation,
        layer: gen
          ? await loadSstLayer(this.fs, gen)
          : SstLayer.fromBlobs([]),
      };
    }
    this.layersStale = false;
    return { wal: this.walCache.overlay, sst: this.sstCache.layer };
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    const { wal, sst } = await this.readLayers();
    return resolveGet(k, wal, sst);
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
    const seq = await this.wal.append(this.writerId, checked as CheckedOp[]);
    this.noteLocalAppend(checked as CheckedOp[], seq);
    this.scheduler.noteAppend(measureOpBytes(checked));
  }

  transaction<T>(body: (tx: Transaction) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    return runTransaction(
      this.wal,
      this.fs,
      this.writerId,
      async (ops, opBytes) => {
        const seq = await this.wal.append(this.writerId, ops);
        this.noteLocalAppend(ops, seq);
        this.scheduler.noteAppend(opBytes);
      },
      body,
    );
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const snap = await this.openViewSnapshot();
    try {
      yield* snap.range(range);
    } finally {
      snap.close();
    }
  }

  async view<T>(body: (snap: ViewSnapshot) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const snap = await this.openViewSnapshot();
    try {
      return await body(snap);
    } finally {
      snap.close();
    }
  }

  private async openViewSnapshot(): Promise<ViewSnapshotImpl> {
    const { wal, sst } = await this.readLayers();
    const walHead = this.walCache?.head ?? 0;
    const generation = this.sstCache?.generation ?? 0;
    if (!this.sortedPuts) {
      this.sortedPuts = mergePuts(sst.asOverlay(), wal);
    }
    return new ViewSnapshotImpl(walHead, generation, this.sortedPuts);
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
    this.invalidateCaches();
    if (this.bus && this.onBusMessage) {
      this.bus.removeEventListener("message", this.onBusMessage);
      this.bus.close();
    }
    if (this.ownsIngestClient) this.ingestClient.close();
    this.wal.close();
  }
}
