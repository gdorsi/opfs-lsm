---
"@opfs-lsm/yjs": patch
---

A doc whose state is over 8 MiB is no longer merged, and `flush()` and `destroy()` resolve for it while no write of its updates failed. Before, the merge failed on kv's batch limit, and every later `flush()` and `destroy()` rejected with `ConstraintError` although every update was stored.
