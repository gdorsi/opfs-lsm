---
"@opfs-lsm/kv": patch
---

The reserve file comes back after an `onStorageFull` handler frees space outside kv while a few unflushed writes wait in the WAL, and after a handler that frees space with `dangerousDestroy`. Before, the host kept no reserve until enough later writes started a flush. A `range` scan no longer hands out an empty key, out of order, after the app transfers the `ArrayBuffer` of a value it read earlier in the scan.
