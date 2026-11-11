---
"@opfs-lsm/kv": minor
---

Two changes to the `@opfs-lsm/kv/testing` entry. Breaking: `EngineHost.ingest(name, waitForCompaction?)` and `IngestClient.ingest(name, waitForCompaction?)` no longer take a `through` seq; a flush always folds the WAL as it stands when the flush starts. New: `EngineHost.compact(name)` waits for a flush in flight and compacts without folding the WAL. A tab and a SharedWorker must now run the same build: the port's `ingest` message no longer carries `through`. The app API is unchanged.
