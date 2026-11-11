---
"@opfs-lsm/kv": patch
---

`update` acks about 40 µs sooner in Chrome. Its WAL transaction now commits as soon as the record is queued and no longer waits for the add's result to reach the tab. docstore `put`, `putMany` and `update` go through the same path.
