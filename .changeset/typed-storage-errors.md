---
"@opfs-lsm/kv": minor
---

Give two storage failures a typed error, and stop a file leak. `ingest()` rejects with the new `StorageFullError` (code `quota`) when the browser refuses a flush or compaction write for lack of quota; it was a plain `Error`. `openDb` rejects with `StorageUnavailableError` when the browser's IndexedDB store fails to open, with the browser's error as `cause`; it was a raw `DOMException`. Manifest reclaim now removes the `.crswap` file Chrome leaves in `m/` when the browser dies during a manifest write.
