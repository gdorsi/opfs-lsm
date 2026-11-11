---
"@opfs-lsm/kv": minor
"@opfs-lsm/docstore": patch
---

A batch no longer has a limit of 10,000 ops. The limit of 8 MiB of keys and values per batch stays. A batch of many small ops uses memory in each open tab for each op, beyond the bytes that limit counts.
