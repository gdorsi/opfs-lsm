---
"@opfs-lsm/kv": minor
---

`openDb` takes `reserveBytes`, 24 MiB unless given. The SharedWorker keeps a file of that size and deletes it when the browser refuses a write, so the write lands, then calls `db.onStorageFull` in one tab to free space. `put`, `delete`, `batch` and `update` reject with `StorageFullError` when the browser refuses them again. `maxBytes`, `db.onPressure`, `Pressure` and `PressureHandler` are removed: pass no option for the default reserve, and move the handler to `db.onStorageFull`.
