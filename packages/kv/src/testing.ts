/**
 * Test harness. bench/ also uses `ingest`, `readStats` and `settle`. Apps should import
 * from `@opfs-lsm/kv` only.
 */
import { readEngineWith } from "./store/engine.js";

export {
  openHarnessDb,
  destroyHarnessDb,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
} from "./harness.js";
export { EngineHost, attachEngineHostPort, createLocalIngestClient } from "./host/engine-host.js";
export { createPortIngestClient } from "./host/port-client.js";
export type { IngestClient } from "./host/protocol.js";
export {
  ingest,
  readStats,
  settle,
  type IoCount,
  type IoCounters,
  type KvStats,
} from "./stats.js";
export type { AsyncFs, RemovableFs } from "./opfs/async-fs.js";
export { MemoryFs } from "./opfs/memory-fs.js";
export { findBrowserFs, openBrowserFs } from "./opfs/browser-fs.js";
export { ensureEngine } from "./store/engine.js";

// The module names are variables so a browser bundle of this file does not resolve them.
if ((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node) {
  readEngineWith(async (wasmUrl) => {
    const fsMod = "node:fs/promises";
    const urlMod = "node:url";
    const fs = (await import(/* @vite-ignore */ fsMod)) as { readFile: (path: string) => Promise<Uint8Array> };
    const url = (await import(/* @vite-ignore */ urlMod)) as { fileURLToPath: (u: URL) => string };
    return (await fs.readFile(url.fileURLToPath(wasmUrl))) as BufferSource;
  });
}
