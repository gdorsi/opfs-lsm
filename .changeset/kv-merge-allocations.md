---
"@opfs-lsm/kv": patch
---

The merge under `range` and `count` allocates nothing per entry, and a source that yields several keys in a row costs one key comparison each instead of a trip through the heap.
