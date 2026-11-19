---
"@opfs-lsm/kv": patch
---

A scan copies each entry it yields once. It made a view of the key and of the value in the SST block and then copied both, four arrays for the two a caller keeps. It now copies the key out of the block as it reads it, hands that copy to the caller, and copies the value only for an entry it yields. `count` and the entries a merge skips copy no value.
