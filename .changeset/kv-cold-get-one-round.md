---
"@opfs-lsm/kv": patch
---

A cold `get` starts the layout reads of every level it passes at once, instead of waiting for one level before it asks the next. It still stops at the first level that may hold the key, so it reads no page of an older version. Over 120 cold tabs on a settled 100,000-key store, the first `get` after opening has a p90 of 2.9 ms instead of 3.5 ms.
