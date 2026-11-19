---
"@opfs-lsm/kv": patch
---

A flush folds its WAL records with less work in the SharedWorker. To keep the last write of each key it named every key by a hex string, built one byte at a time, and it now uses a string of one char per byte. The runs it writes are the same.
