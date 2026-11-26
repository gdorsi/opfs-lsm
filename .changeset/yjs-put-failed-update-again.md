---
"@opfs-lsm/yjs": patch
---

After a write fails, `flush()` and `destroy()` put the failed updates again, one entry each, instead of the whole doc state. A doc whose state is over the 8 MiB batch limit could never store that repair, so the update was lost at the next load although the disk worked again.
