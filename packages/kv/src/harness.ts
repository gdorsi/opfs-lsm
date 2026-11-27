/**
 * The open path of tests and benches: `openDbWith` on a backing the caller
 * picks. Apps reach `openDb` only, so the in-process host and the memory fs
 * stay out of their bundle.
 */
import {
  canUseBrowserOpfs,
  destroyDbWith,
  NEEDS_BROWSER,
  openOn,
  type Db,
  type OpenOptions,
} from "./db.js";
import { checkDbName, newWriterId, type DbName, type WriterId } from "./check.js";
import { StorageUnavailableError } from "./errors.js";
import { ROW_POST_MS } from "./row-post.js";
import { DEFAULT_MAX_WAL_BYTES } from "./host/budget.js";
import { createLocalIngestClient } from "./host/engine-host.js";
import { MeteredHost } from "./host/metered-host.js";
import { createPortIngestClient } from "./host/port-client.js";
import type { IngestClient } from "./host/protocol.js";
import type { AsyncFs, ReadFs, RemovableFs } from "./opfs/async-fs.js";
import { openBrowserReadFs, openParent } from "./opfs/browser-fs.js";
import { CountingFs } from "./opfs/counting-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";

/**
 * Where the run files live and who flushes them. An fs comes with the client
 * of the host that publishes to it. Without one the fs is OPFS, and the client
 * is the metered worker's unless one is given.
 */
export type Backing =
  | { readonly fs: AsyncFs; readonly ingest: IngestClient }
  | { readonly fs?: undefined; readonly ingest?: IngestClient };

/** Open options for tests and benches, on top of the public ones. */
export type OpenKnobs = {
  /** Stable writer id (tests / debugging). Default: random UUID. */
  readonly writerId?: string;
  /**
   * Flush the WAL into an L0 run once the records waiting for ingest hold this
   * many key and value bytes. It counts every op as written, so overwrites and
   * deletes bound the WAL as much as new keys do, whatever the batch sizes.
   * The host counts the appends tabs announce, and measures the WAL whenever a
   * tab opens the database, so ingest does not depend on any tab staying open
   * or responsive. When tabs pass different limits, the host uses the smallest.
   */
  readonly maxWalBytes?: number;
  /** Replaces `ROW_POST_MS`. At 0 every row is posted when it lands, so a simulation owns all the timing. */
  readonly rowPostMs?: number;
  /** Wraps the fs this tab reads runs through. `openHarnessDb` passes a `CountingFs`, so `readStats` can count the tab's IO. */
  readonly wrapFs?: (fs: ReadFs) => ReadFs;
};

/** What `openDbWith` takes. `openHarnessDb` builds it. */
export type OpenWithOptions = OpenOptions & OpenKnobs & Backing;

/** `openDb` on a backing and with knobs the caller picks. */
export async function openDbWith(options: OpenWithOptions): Promise<Db> {
  return openOn(options, () => {
    const parent = options.fs || !canUseBrowserOpfs() ? undefined : openParent();
    parent?.catch(() => undefined);
    return (name) => {
      if (!options.fs && !parent) throw new StorageUnavailableError(NEEDS_BROWSER);
      const fs = options.fs ?? openBrowserReadFs(name, parent!);
      return {
        fs: options.wrapFs?.(fs) ?? fs,
        ingest: options.ingest ?? meteredWorker(name),
        ownsIngestClient: !options.ingest,
        writerId: (options.writerId ?? newWriterId()) as WriterId,
        rowPostMs: options.rowPostMs ?? ROW_POST_MS,
        maxWalBytes: options.maxWalBytes ?? DEFAULT_MAX_WAL_BYTES,
      };
    };
  });
}

/** `workerIngest` on the worker that runs a `MeteredHost`, so `readStats` answers in a browser. */
function meteredWorker(name: DbName): IngestClient {
  // Inline in the constructor, as in `workerIngest`, so bundlers emit the worker chunk.
  return createPortIngestClient(
    typeof SharedWorker === "undefined"
      ? new Worker(new URL("./host/metered-worker.js", import.meta.url), { type: "module", name: `opfs-lsm:${name}` })
      : new SharedWorker(new URL("./host/metered-worker.js", import.meta.url), { type: "module", name: `opfs-lsm:${name}` }).port,
  );
}

export type HarnessOpenOptions = OpenOptions &
  OpenKnobs & {
    /**
     * SST/generation filesystem used for reads on this tab.
     * Must match what the ingest host publishes to. Omit for OPFS.
     */
    readonly fs?: AsyncFs;
    /**
     * Ingest client. Omit for the metered worker when the fs is OPFS,
     * and for an in-process EngineHost on a given or memory fs.
     */
    readonly ingest?: IngestClient;
    /**
     * Keep the run files in a MemoryFs shared by every open of this name in
     * the process, with an in-process EngineHost. The only way to get memory
     * storage without passing `fs`: an open that cannot reach OPFS rejects.
     */
    readonly forceMemory?: boolean;
  };

const memoryFsByName = new Map<string, MemoryFs>();
/** The in-process host that publishes to each fs. */
const localHosts = new WeakMap<AsyncFs, MeteredHost>();

function memoryFs(name: string): MemoryFs {
  let fs = memoryFsByName.get(name);
  if (!fs) {
    fs = new MemoryFs();
    memoryFsByName.set(name, fs);
  }
  return fs;
}

function localIngest(fs: AsyncFs): IngestClient {
  let host = localHosts.get(fs);
  if (!host) {
    host = new MeteredHost(() => fs);
    localHosts.set(fs, host);
  }
  return createLocalIngestClient(host);
}

/** `fs`, or the memory fs of `forceMemory`. Memory is never a fallback: only a harness that asks for it gets it. */
function harnessFs<F extends AsyncFs>(options: HarnessOpenOptions & { readonly fs?: F }): F | MemoryFs | undefined {
  return options.fs ?? (options.forceMemory === true ? memoryFs(checkDbName(options.name)) : undefined);
}

function backingOf(options: HarnessOpenOptions): Backing {
  const fs = harnessFs(options);
  if (fs) return { fs, ingest: options.ingest ?? localIngest(fs) };
  return options.ingest ? { ingest: options.ingest } : {};
}

/** `reserveBytes` is 0 unless given, so a test or a bench writes no reserve file it did not ask for. */
export async function openHarnessDb(options: HarnessOpenOptions): Promise<Db> {
  const { fs: _fs, ingest: _ingest, forceMemory: _forceMemory, ...rest } = options;
  // The tab only reads its fs, so a read-only one counts like a full one.
  return openDbWith({ wrapFs: (fs) => new CountingFs(fs as AsyncFs), reserveBytes: 0, ...rest, ...backingOf(options) });
}

/** `destroyDb` on the harness's storage: `fs`, or the memory fs of `forceMemory`, is the folder to remove. */
export async function destroyHarnessDb(options: HarnessOpenOptions & { readonly fs?: RemovableFs }): Promise<void> {
  return destroyDbWith({ name: options.name, fs: harnessFs(options) });
}

export function __resetMemoryFsForTests(name: string): void {
  memoryFsByName.delete(name);
}
