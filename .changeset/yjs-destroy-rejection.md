---
"@opfs-lsm/yjs": patch
---

`doc.destroy()` after a failed write no longer causes an unhandled rejection, and a later `destroy()` waits for the same teardown and rejects with its error.
