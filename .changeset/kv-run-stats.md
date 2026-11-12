---
"@opfs-lsm/kv": minor
---

Expired rows, deletes and range-deleted rows now give their disk space back even in a level under its size budget. Each SST file carries statistics of its entries, which the manifest copies, and compaction rewrites a file once about half of it is dead or drops a file a range delete covers whole without a merge. Opening a database starts a compaction pass, so rows that expired while it sat idle leave the disk. SST format 3 and manifest format 6: a database written by an earlier version refuses to open.
