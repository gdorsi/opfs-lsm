---
"@opfs-lsm/automerge": patch
---

A storage key with a segment past 65,535 bytes now throws `ConstraintError`, as every other key over 8 KiB does. It threw a plain `Error`.
