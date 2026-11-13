---
"@opfs-lsm/kv": patch
---

Post the rows of a burst of writes to other tabs in one `BroadcastChannel` message. A tab still posts a write at once when it has not posted in the last 4 ms, and always from a hidden page; a write that lands sooner waits for the first one past that time, or for a timer, so other tabs see the writes of a burst a few milliseconds later than before. `db.sync()` still returns every acked write. The message is now `{ kind: "rows", rows }`. A tab on an earlier version reads the WAL when it gets one, and its own `row` messages no longer count toward the automatic flush, so reload tabs after upgrading. In Chrome 157, 10,000 awaited single puts ran at 0.69 to 0.78 of the speed of plain IndexedDB writes before, and at 0.82 to 0.94 after.
