---
"@opfs-lsm/kv": patch
---

A `get` of a flushed key copies its value once. It copied the key out of the SST block, copied the value twice and read the seq through a BigInt, and a caller only ever saw one value copy. `ViewSnapshot.get`, `update` and `rangeJoin` read through the same path.
