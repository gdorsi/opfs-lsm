---
"@opfs-lsm/kv": patch
---

A key of 65 bytes to 1 KiB is now copied into a shared 8 KiB buffer, as values of that size are, instead of an array with its own buffer, which Chrome and Node allocate several times slower than the copy. This holds for the key a write keeps, the key of an entry that `range`, `rangeValues` and `rangeJoin` hand out, and the key `encodeTuple` returns. Each is still a copy you may change. Read it through `byteOffset` and `byteLength`, and `slice()` it before you post, store or transfer it. A point read hashes its key for the Bloom filters once, not once per level.
