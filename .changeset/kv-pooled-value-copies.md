---
"@opfs-lsm/kv": patch
---

A write copies each value of 65 to 1,024 bytes into a shared pool buffer, as a read already does, instead of allocating a buffer per value. `tx.put` still copies at the call. A short copy no longer uses `slice`, which is a view on a Node `Buffer`.
