---
"@opfs-lsm/kv": minor
---

`count` no longer walks the entries it counts, and `range` takes an `offset` that skips entries without reading them, when the writes of the range recorded what they replaced. An `update` records it for every key it read. For a key it writes without reading, such as an index entry derived from a row it read, pass `{ was: "absent" | "present" }` to `tx.put` or `tx.delete`; `batch`, `put` and `delete` refuse it. A count then adds up what the writes did and reads at most two blocks of each level. A range with writes that read nothing is still scanned, until compaction has merged them into the bottom level, and so is a range under a `deleteRange` that compaction has not finished, and a count with `valueContains`.

The run format is now version 2, the manifest format version 6, and a WAL op's type byte carries `was`. A database written by an earlier version refuses to open with `CorruptDatabaseError`; call `destroyDb` and open it again.
