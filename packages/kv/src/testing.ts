/**
 * Test and bench harness. Apps should import from `@opfs-lsm/kv` only.
 */
export {
  openDbWith as openHarnessDb,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
} from "./db.js";
export {
  EngineHost,
  createLocalIngestClient,
  createPortIngestClient,
} from "./host/engine-host.js";
export type { IngestClient } from "./host/protocol.js";
export type { AsyncFs } from "./opfs/async-fs.js";
export { MemoryFs } from "./opfs/memory-fs.js";
export { openBrowserFs } from "./opfs/browser-fs.js";
export {
  DEFAULT_INGEST_POLICY,
  type IngestPolicy,
} from "./ingest-policy.js";
