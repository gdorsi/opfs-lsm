---
"@opfs-lsm/kv": patch
---

A `dangerousDestroy` in flight when its handle closes now rejects with `ClosedError`. It rejected with a plain `Error`, or never settled when the handle closed between two of its steps.
