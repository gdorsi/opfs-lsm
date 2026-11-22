---
"@opfs-lsm/kv": patch
---

A `sync()` made while another one ran, and a `put` whose row committed while it waited on one, no longer reject with IndexedDB's `InvalidStateError` when `close()` comes in between. They settle as a lone `sync()` cut off by `close()` does, and the `put` resolves with its seq: its write is stored.
