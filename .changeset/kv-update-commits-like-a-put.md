---
"@opfs-lsm/kv": patch
---

`update` commits like a `put` when no other write lands between its read and its commit: one IndexedDB round trip, where it took a transaction of its own. Concurrent updates still lose nothing. When another write does get in first, `body` runs a second time inside a transaction, so keep it free of side effects. A body that writes nothing runs twice too. The updates of one handle run one at a time, in call order, and a `changes` subscriber can receive an append with no ops, for the row of an update that ran again.
