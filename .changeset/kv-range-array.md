---
"@opfs-lsm/kv": minor
"@opfs-lsm/docstore": patch
"@opfs-lsm/yjs": patch
"@opfs-lsm/automerge": patch
"@opfs-lsm/fate": patch
---

`range` on `Db` and on a view snapshot now resolves with an array of entries instead of returning an async iterator. Replace `for await (const e of db.range(r))` with `for (const e of await db.range(r))`. Use `limit` to bound a scan. A scan takes its snapshot when you call it, and holds no run files after it resolves.
