---
"@opfs-lsm/kv": patch
---

Two changes to the `@opfs-lsm/kv/testing` entry. `openHarnessDb` takes `maxWalBytes` directly, in place of `ingestPolicy: { maxWalBytes }`, and the `IngestPolicy` type is gone. `HostStats.l0Stops` moved out of `memory` and sits next to `flushes`. The app API is unchanged.
