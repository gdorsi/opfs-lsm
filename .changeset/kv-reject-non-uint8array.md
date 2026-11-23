---
"@opfs-lsm/kv": patch
---

A key or value that is not a `Uint8Array` now throws `ConstraintError`. Before, a value such as an `ArrayBuffer` overwrote other stored values.
