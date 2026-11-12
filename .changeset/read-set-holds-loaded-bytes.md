---
"@opfs-lsm/kv": patch
---

`update` no longer hangs when the keys it reads sit in more run pages than `cacheBytes` holds. That covers docstore's `putMany` and `modifyMany` and the TanStack DB adapter's writes. A read now keeps the pages it loaded until it ends, outside the cache budget, so the cache never has to hold more than `cacheBytes`.
