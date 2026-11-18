---
"@opfs-lsm/kv": patch
---

`openDb` is faster in a fresh tab: about 3.9 ms where it took 5.0 ms on a 100,000-entry database. A flush or a compaction now stores the bytes of the manifest it records in IndexedDB, so a tab opens the run files while it reads the manifest file, instead of after. The open also looks up `opfs-lsm/` while it waits for its lock, and checks recovery while it reads the WAL tail and opens the runs. A database written by an earlier version opens as before and gets the copy at its next flush.
