---
"@opfs-lsm/kv": patch
---

In the `@opfs-lsm/kv/testing` entry, a `watch` that reaches the host with a zero or negative `compactionMemoryBytes` now gets the 32 MiB default, as `openDb` already gave it; the host used to clamp it to 8 MiB. The app API is unchanged.
