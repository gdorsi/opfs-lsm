---
"@opfs-lsm/kv": patch
---

The wasm engine is now written in Zig instead of Rust. It writes the same runs, merges to the same bytes and reports the same errors, so stored data reads as before. A flush encodes about 15% faster, and merges and block scans run at the same speed. A flush leaves less wasm memory behind: after three 4 MiB flushes the module holds 11.6 MiB instead of 30.8 MiB. `engine.wasm` is 31.4 kB, 10.9 kB with brotli, 0.9 kB less than before.
