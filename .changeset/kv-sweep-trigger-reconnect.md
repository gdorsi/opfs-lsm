---
"@opfs-lsm/kv": patch
---

Fix four faults. A sweep keeps the runs of a manifest whose IndexedDB commit failed, so two power losses can no longer make the database read rows that are not a log prefix. Writes of no bytes, such as a range delete of everything, count toward `maxWalBytes`, so the host flushes them. A handle writes again after a refused write whose call to the host failed. Two `changes()` or `onStorageFull()` subscriptions of one function end apart.
