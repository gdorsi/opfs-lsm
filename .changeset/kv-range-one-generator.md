---
"@opfs-lsm/kv": patch
---

`range` yields each entry through one async generator. `Db.range` and `ViewSnapshot.range` wrapped a second generator, so every entry paid for two, and `rangeJoin` read its scan through one as well. An iterator behaves as before: it queues `next()` calls made without waiting, checks the handle on every entry, and lets go of its run files when it ends, when the caller returns early and when a read fails.
