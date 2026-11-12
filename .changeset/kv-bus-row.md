---
"@opfs-lsm/kv": patch
---

A write reaches other tabs and the SharedWorker as the WAL row it appended, one buffer, instead of one cloned object per op. The SharedWorker takes the byte count it needs from the message instead of reading the ops. A batch of many small ops, such as a docstore write with several indexes, costs less on the main thread. The message has a new kind, so a tab of an older build on the same origin catches up from the WAL when it gets one.

Checking a key or a value for a detached buffer no longer makes V8 allocate a buffer for every small array.
