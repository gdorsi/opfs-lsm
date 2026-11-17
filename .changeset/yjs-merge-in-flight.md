---
"@opfs-lsm/yjs": patch
---

A merge of a doc's stored updates now waits for the doc's own writes still in flight before it reads. Before, a merge that started while the WAL was behind (a burst of thousands of updates, then a second of quiet) deleted only the updates that had landed and left the rest stored next to the merged state. The next load replayed those before the merged state, without the updates they build on, and Yjs's handling of such updates is quadratic: one cold load took 17 s in the benchmark instead of 15 ms.
