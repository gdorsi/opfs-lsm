/**
 * Test harness. bench/ also uses `ingest`, `readStats` and `settle`. Apps should import
 * from `@opfs-lsm/kv` only.
 */
export {
  openHarnessDb,
  destroyHarnessDb,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
} from "./harness.js";
export type { OpenSpan, OpenTrace } from "./db.js";
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
export type { AsyncFs } from "./opfs/async-fs.js";
export { MemoryFs } from "./opfs/memory-fs.js";
export { openBrowserFs } from "./opfs/browser-fs.js";
export { engineUsingWasm, ensureEngine } from "./store/engine.js";
