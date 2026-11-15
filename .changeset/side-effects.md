---
"@opfs-lsm/kv": patch
"@opfs-lsm/docstore": patch
"@opfs-lsm/tanstack-db": patch
"@opfs-lsm/yjs": patch
"@opfs-lsm/automerge": patch
"@opfs-lsm/fate": patch
---

Every package now declares `sideEffects` in its `package.json`, so webpack and esbuild drop the modules an app does not import. With webpack, an app that imports only the error classes from `@opfs-lsm/kv` bundles 135 bytes brotli instead of 438, and no longer gets the SharedWorker chunk and the wasm file in its build output.
