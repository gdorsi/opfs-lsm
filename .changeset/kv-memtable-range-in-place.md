---
"@opfs-lsm/kv": patch
---

A scan reads the memtable's rows in place instead of copying every row in its bounds first, so `range({ limit })` and a paged scan over a full memtable cost what they read. A range delete rewrites only the memtable chunks it touches instead of the whole table.
