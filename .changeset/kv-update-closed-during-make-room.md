---
"@opfs-lsm/kv": patch
---

An `update` whose handle closes while its refused append is retried rejects with `ClosedError` or `StorageFullError`. Before, it could reject with the browser's `InvalidStateError`.
