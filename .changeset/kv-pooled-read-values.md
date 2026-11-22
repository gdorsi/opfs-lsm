---
"@opfs-lsm/kv": patch
---

A value of 65 bytes to 1 KiB that a read hands out is now a view of a shared 8 KiB buffer, as Node's Buffer pool makes them, instead of an array with its own buffer. It is still a copy you may change. Read it through `byteOffset`, a multiple of 8, and `byteLength`. Posting or storing it clones the whole shared buffer, and transferring that buffer detaches the other copies, so `slice()` it before you post, store, transfer or keep it.
