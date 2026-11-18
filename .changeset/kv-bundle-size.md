---
"@opfs-lsm/kv": patch
"@opfs-lsm/docstore": patch
---

Smaller bundles: `openDb` ships about 760 bytes less brotli and `openDocStore` about 800 less, with no change to the app API, to the disk format or to any read or write path. Two changes to the `@opfs-lsm/kv/testing` entry come with it: `EngineHost.compact(name)` is gone, since the SharedWorker no longer ships a method that only tests call, and the `trace` option of `openHarnessDb` is gone with the `OpenTrace` and `OpenSpan` types and the open timing they recorded.
