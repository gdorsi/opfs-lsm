---
"@opfs-lsm/kv": patch
---

An `update` whose handle closes while the SharedWorker frees space for its refused append rejects with `ClosedError`. Before, it rejected with the browser's `InvalidStateError`.
