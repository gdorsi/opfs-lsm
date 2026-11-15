---
"@opfs-lsm/kv": patch
---

`openDb` no longer counts the calls and bytes of each OPFS read the tab makes, so the tab bundle is 203 bytes brotli smaller. `readStats` from `@opfs-lsm/kv/testing` now reports `tab.fs` only for a database that `openHarnessDb` opened.
