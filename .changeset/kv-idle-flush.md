---
"@opfs-lsm/kv": patch
---

The host flushes a database that got no write for 2 seconds, when at least an eighth of `maxWalBytes` is waiting. A tab that opens it then replays a short WAL tail instead of everything written since the last flush.
