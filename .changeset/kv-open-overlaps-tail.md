---
"@opfs-lsm/kv": patch
---

`openDb` opens the runs of the recorded generation as soon as it has read which one that is, while the WAL tail's records are still being read, instead of after them. The tail is read in ranges of 100 records, all in flight at once, so one range decodes while the next is read. A tab that opens a database with unflushed writes is ready sooner.
