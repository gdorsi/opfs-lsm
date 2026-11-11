---
"@opfs-lsm/kv": patch
---

`openDb` resolves about 0.5 to 1 ms sooner in Chrome. IndexedDB and OPFS now open at the same time, recovery reads the WAL and lists manifests together, and a tab looks up each directory once.
