---
"@opfs-lsm/docstore": minor
---

A query takes `offset`: the results to pass over before the first one. It walks the index entries it passes and reads none of their documents. `count` passes over them too.

`getMany`, `get` and an index `query` parse each document from the bytes kv holds, with no copy between, and `getMany` is one kv read: every document sees the same writes. A query reads the catalog the same way. In the `tracker/goals` benchmark on an Apple M2 Pro (medians of 5 runs before and after, warm), a window of 50 rows at 90% of a project's list went from 0.785 ms to 0.400 ms with `offset`, the column a bulk edit just emptied from 1.02 ms to 0.687 ms, and the issue counts per status from 0.179 ms to 0.146 ms.
