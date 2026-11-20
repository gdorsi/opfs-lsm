---
"@opfs-lsm/kv": patch
---

A write places its rows in the memtable with fewer byte compares. The search skips the bytes that both of its bounds already share with the key, so keys with a long common prefix, as docstore's are, cost one pass over that prefix and not one per step. An import batch of 1,000 rows is 3 to 5% faster in the tracker benchmark.
