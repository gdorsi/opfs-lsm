---
"@opfs-lsm/kv": minor
---

Export only the app API from `@opfs-lsm/kv`: `openDb`, `prefixBound`, the types of `Db`, and the error classes. Breaking:

- `EngineHost`, `createLocalIngestClient`, `createPortIngestClient`, `attachEngineHostPort`, `MemoryFs`, `openBrowserFs`, `ensureEngine`, `engineUsingWasm` and the types `IngestClient`, `AsyncFs` and `IngestPolicy` are now exported from `@opfs-lsm/kv/testing` only.
- `BrowserFs`, `FileWriter`, `SstEntry`, `encodeSst`, `decodeSst` and `DEFAULT_INGEST_POLICY` are no longer exported. `openDb` never accepted them.
