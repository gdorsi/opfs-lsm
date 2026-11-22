---
"@opfs-lsm/kv": patch
---

A value of 65 bytes to 1 KiB that a read hands out is now a view of a shared 8 KiB buffer, as Node's Buffer pool makes them, instead of an array with its own buffer. It is still a copy you may change. Read it through `byteOffset`, a multiple of 8, and `byteLength`, and `slice()` it before you post or store its `buffer`.
