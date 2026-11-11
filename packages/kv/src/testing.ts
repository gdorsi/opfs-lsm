/**
 * Test harness. bench/ also uses `ingest`, `readStats` and `settle`. Apps should import
 * from `@opfs-lsm/kv` only.
 */
export {
  openDbWith as openHarnessDb,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
  type OpenSpan,
  type OpenTrace,
} from "./db.js";
export {
  EngineHost,
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient,
} from "./host/engine-host.js";
export type { IngestClient } from "./host/protocol.js";
export {
  ingest,
  readStats,
  settle,
  type IoCount,
  type IoCounters,
  type KvStats,
} from "./stats.js";
export type { AsyncFs } from "./opfs/async-fs.js";
export { MemoryFs } from "./opfs/memory-fs.js";
export { openBrowserFs } from "./opfs/browser-fs.js";
export type { IngestPolicy } from "./ingest-policy.js";
export { engineUsingWasm, ensureEngine } from "./store/engine.js";
