---
"@opfs-lsm/kv": patch
---

A Bloom filter check on a `get` computes each probe's bit with integer arithmetic. The remainder that picks the bit ran on doubles, which took most of the check's time.
