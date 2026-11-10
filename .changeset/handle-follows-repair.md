---
"@opfs-lsm/kv": patch
---

An open handle now follows a repair that falls back to an older manifest. When files of the recorded generation went missing under a running page and the repair emptied the WAL, every open handle kept its old runs, and its writes and `sync()` rejected with `CommitError("wal gap before seq …")` until the page reopened the database. A handle now loads the older manifest when the WAL has moved past its memtable.
