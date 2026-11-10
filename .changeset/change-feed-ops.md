---
"@opfs-lsm/kv": minor
---

`changes()` now reports what changed. An `append` event carries the record's seq and ops, and every seq a handle applies is announced once, in seq order, whether it came from this tab, from another tab's BroadcastChannel message, or from a `sync()` catch-up. A handle that skipped records a flush folded gets a `gap` event and should read again, and `close()` ends the feed with `closed`. `put`, `delete` and `batch` resolve with the record's seq, and an `append` event no longer has a `writerId`.
