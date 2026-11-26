---
"@opfs-lsm/kv": patch
---

An `update` now reads every write its handle issued before it. An update called right after a `put` of the same handle could run before that put when the put waited for the next group commit, or when the browser refused the put's group for lack of space: its `body` read the older value, and the put then replaced what the update wrote.

A `changes()` listener that calls `close()` no longer takes the event being delivered away from the listeners after it. Every listener gets the append, then `closed`.
