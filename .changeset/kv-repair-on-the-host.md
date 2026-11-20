---
"@opfs-lsm/kv": patch
---

Importing `@opfs-lsm/kv` adds 19.2 kB of JavaScript to the main bundle (gzip), down from 20.0 kB. A tab no longer carries the writes of recovery. When an open finds that IndexedDB and OPFS disagree, after a power loss or a `destroyDb`, it asks the SharedWorker to record the repair, so only one repair runs however many tabs open at once. An open of a healthy database or of a new one is unchanged, and does not wait for the SharedWorker.
