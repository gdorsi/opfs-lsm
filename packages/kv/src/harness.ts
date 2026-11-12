/**
 * The open path of tests and benches: `openDbWith` on a backing the caller
 * picks. Apps reach `openDb` only, so the in-process host and the memory fs
 * stay out of their bundle.
 */
import { checkDbName } from "./check.js";
import { destroyDbWith, openDbWith, type Backing, type Db, type OpenKnobs, type OpenOptions } from "./db.js";
import { contextClock, WallClock } from "./clock.js";
import { EngineHost, createLocalIngestClient } from "./host/engine-host.js";
import type { IngestClient } from "./host/protocol.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import { MemoryFs } from "./opfs/memory-fs.js";

export type HarnessOpenOptions = OpenOptions &
  OpenKnobs & {
    /**
     * SST/generation filesystem used for reads on this tab.
     * Must match what the ingest host publishes to. Omit for OPFS.
     */
    readonly fs?: AsyncFs;
    /**
     * Ingest client. Omit for the package SharedWorker when the fs is OPFS,
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
const localHosts = new Map<string, EngineHost>();

function memoryFs(name: string): MemoryFs {
  let fs = memoryFsByName.get(name);
  if (!fs) {
    fs = new MemoryFs();
    memoryFsByName.set(name, fs);
  }
  return fs;
}

function localIngest(name: string, fs: AsyncFs, clock: (() => number) | undefined): IngestClient {
  let host = localHosts.get(name);
  if (!host) {
    host = new EngineHost(() => fs, {}, clock ? new WallClock(clock) : contextClock);
    localHosts.set(name, host);
  }
  return createLocalIngestClient(host);
}

function backingOf(options: HarnessOpenOptions): Backing {
  const name = checkDbName(options.name);
  // Memory is never a fallback: only a harness that asks for it gets it.
  const fs = options.fs ?? (options.forceMemory === true ? memoryFs(name) : undefined);
  if (fs) return { fs, ingest: options.ingest ?? localIngest(name, fs, options.clock) };
  return options.ingest ? { ingest: options.ingest } : {};
}

export async function openHarnessDb(options: HarnessOpenOptions): Promise<Db> {
  const { fs: _fs, ingest: _ingest, forceMemory: _forceMemory, ...rest } = options;
  return openDbWith({ ...rest, ...backingOf(options) });
}

export async function destroyHarnessDb(options: HarnessOpenOptions): Promise<void> {
  return destroyDbWith({ name: options.name, ...backingOf(options) });
}

export function __resetMemoryFsForTests(name: string): void {
  memoryFsByName.delete(name);
  localHosts.delete(name);
}
