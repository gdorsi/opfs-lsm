---
"@opfs-lsm/kv": patch
---

A write that waits behind another append when `destroyDb`, or the browser, closes the handle's IndexedDB connection now rejects with `ClosedError`. It rejected with IndexedDB's `InvalidStateError`.
