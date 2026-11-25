---
"@opfs-lsm/tanstack-db": patch
---

An on-demand collection drops the rows no live query keeps once after several loads settle in one task, not once per load. Each pass walks every row the collection holds, so queries that land together no longer repeat it.
