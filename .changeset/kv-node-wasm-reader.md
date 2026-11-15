---
"@opfs-lsm/kv": patch
---

The wasm engine loader no longer ships a Node file reader to the browser, which takes 176 bytes brotli off kv's bundle. Bundling kv with webpack no longer prints "Critical dependency: the request of a dependency is an expression". Node code that loads kv's engine, such as tests on `openHarnessDb`, gets the file reader by importing `@opfs-lsm/kv/testing`.
