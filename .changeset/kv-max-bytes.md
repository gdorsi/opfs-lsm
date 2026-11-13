---
"@opfs-lsm/kv": minor
---

Add `openDb({ maxBytes })` and `db.onPressure(handler)`. When the SST files pass `maxBytes`, the SharedWorker offers `{ bytes, maxBytes, need }` to the one handle that holds the Web Lock `opfs-lsm-pressure/<name>`, and its handlers remove what the layer chooses with ordinary writes. kv never removes a row for the cap, and a write never waits for it. A handle opened with `maxBytes` and no handler warns once per offer when no handle answers.
