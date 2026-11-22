---
"@opfs-lsm/kv": patch
---

The wasm engine (`wasm/engine.wasm`) is built from AssemblyScript instead of Rust. It takes the same calls and writes the same bytes, so stored data reads as before. The module is about half the size, 6.5 kB gzipped instead of 13.3 kB, and a flush or a compaction step reaches less wasm memory. Building it from source needs only `pnpm install`.
