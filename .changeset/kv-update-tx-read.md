---
"@opfs-lsm/kv": minor
---

The body of `update` can read more keys: `tx.read(keys)` returns their values in the same state as the update's own. Use it for a key the body learns only from what it read, such as the target of a pointer. A value held in memory comes back at once, so the update still costs what a `put` costs. For any other, `read` ends that run of the body, kv loads the value and runs the body again. The `tx` of `update` has the new type `UpdateTx`. The main-thread JavaScript grows by 0.1 kB gzip, to 19.5 kB.
