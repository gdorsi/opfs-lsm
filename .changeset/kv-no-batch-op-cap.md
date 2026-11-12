---
"@opfs-lsm/kv": minor
"@opfs-lsm/docstore": patch
---

A batch no longer has a limit of 10,000 ops. The limit of 8 MiB per batch stays, and it now counts 256 bytes for each op on top of the key bytes and the value bytes, as the memtable does. A batch of small ops can hold about 30,000 of them. A batch of fewer than 10,000 ops that was within about 2.4 MiB of the limit is now over it. The separate limit of 16 MiB per value is gone: no write could reach it, because a `put` is a batch of one op.
