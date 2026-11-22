---
"@opfs-lsm/kv": patch
---

A cold `get` starts the reads of every level it passes at once, instead of waiting for one level before it asks the next. A first `get` after opening a store waits on about half as many rounds of reads when the key sits below several runs, and its p90 dropped from 3.5 ms to 2.8 ms over 120 cold tabs on a settled 100,000-key store.
