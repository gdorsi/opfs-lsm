---
"@opfs-lsm/kv": patch
---

A `range` iterator answers a `next()` whose entry is in memory in the call itself. `Db.range` and `ViewSnapshot.range` were async generators that wrapped a second one, so every entry spent several promise turns twice, and `rangeJoin` read its scan through one as well. An iterator still answers calls in the order they were made, checks the handle on every entry, and lets go of its run files when it ends, when the caller returns early and when a read fails. It inherits from the async iterator prototype as a generator does, so `await using` and `yield*` work on it, and a `throw()` ends it as a failed read does. `return()` ignores its argument.
