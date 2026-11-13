---
"@opfs-lsm/kv": patch
---

Make `put`, `delete` and `batch` one round trip to IndexedDB. The append no longer reads the head floor or waits for its record's key before the commit starts: recovery and destroy now move the WAL's key generator whenever they move the head past the records. In Chrome 157 an awaited single put went from a p50 of 148 µs to 114 µs. Databases written by earlier versions are not migrated: one that an earlier version destroyed, or recovered after a power loss, and that took no write since, loses the first writes it takes under this version.
