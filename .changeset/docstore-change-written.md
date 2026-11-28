---
"@opfs-lsm/docstore": minor
---

Each change of `changes()` has `written(index)`: the entries the write added to that index and removed from it, as `{ added, removed }` in index order. It reads nothing and decodes no document, so a count kept from an index moves by the difference of the two lengths. It takes the same indexes as `before`.
