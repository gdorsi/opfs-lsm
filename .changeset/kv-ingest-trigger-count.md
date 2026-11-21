---
"@opfs-lsm/kv": patch
---

The SharedWorker keeps the count of the rows written while one of its flushes waited and then found nothing left to fold. It dropped that count, so the WAL could grow past `maxWalBytes` with no flush until another `maxWalBytes` arrived or the database went quiet. This needs a second host on the database, as when tabs run without a SharedWorker.
