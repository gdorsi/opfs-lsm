---
"@opfs-lsm/kv": patch
---

A request to the SharedWorker that is made after its handle closed, or is pending when it closes, rejects with `ClosedError`. Before, the later request never settled, so a `dangerousDestroy()` whose `changes` listener closed the handle hung, and the pending one rejected with a plain `Error`.
