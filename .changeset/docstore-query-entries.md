---
"@opfs-lsm/docstore": minor
---

`queryEntries(q)` is new on a collection and on a `view` snapshot. It takes the same query as `queryIds` and returns `{ entries, next }`, where each entry is `{ id, values }`: the document id and the values its index orders it by. It reads no document, so a page of index values costs what `queryIds` costs. Use it to group or merge on indexed fields without loading the documents. In the `tracker/goals` benchmark, counting open issues per assignee with one `queryEntries` went from 3.33 ms to 0.60 ms, and the triage page, which merges four index ranges before loading 50 documents, went from 1.06 ms to 0.78 ms (median of 6 runs each).
