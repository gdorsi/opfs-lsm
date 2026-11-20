---
"@opfs-lsm/kv": minor
---

A scan leaves each record of a run in its block until it yields the entry, and the merge compares keys there. An entry that `count` counts, that a newer version or a tombstone drops, or that `offset` passes over no longer copies its value, and copies its key only when it waits in the merge through several compares. The merge keeps its waiting sources in a short sorted list instead of a binary heap, and remembers which sources tie on a key, so two versions of one key are compared once.

A scan under a range delete compares its entries with the delete's bounds in place too, and only with the range deletes that reach into the scan's own bounds.

`Range.offset` is new: `range`, `count` and `rangeJoin` pass over that many entries before the first one, and `limit` counts from there. A `limit` or an `offset` that is not an integer of 0 or more now rejects with `ConstraintError`.

`getMany(keys)` is new on `Db` and on a `view` snapshot. It reads every key in one read, in the order asked, and the pages they lack load together. With a second argument, `getMany(keys, decode)`, a value is not copied: `decode` gets the bytes where they are stored and returns what to keep. `rangeJoin` takes the same `decode` for the values it joins, and `rangeValues(range, decode)` on a `view` snapshot returns a range's entries with each value decoded that way.
