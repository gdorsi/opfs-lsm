---
"@opfs-lsm/kv": patch
---

Writes that wait at the `memtableBytes` limit append in call order: a `put` called while an earlier one waits no longer lands first, so the later value is the one stored.
