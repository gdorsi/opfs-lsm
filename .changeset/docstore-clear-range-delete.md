---
"@opfs-lsm/docstore": minor
---

`clear` deletes the collection's documents and index entries with one kv range delete, in the transaction that updates the catalog, and keeps the collection's id. Removing an index, dropping a collection and a failed backfill delete their keys the same way, in the write that changes the catalog, so no background sweep is left to run and `whenIdle` waits only for backfills. A clear no longer uses up a collection id, so clearing often cannot run out of them. A backfill of a cleared collection stops at its next chunk, since the clear marks its index ready. A cursor made before a `clear` now stays valid and resumes after its position, instead of throwing `"cursor"`; documents written since that sort at or before it are skipped. Like any kv range delete, a clear makes every tab rebuild its memtable once.

The stored catalog format is now 3. A database written by an earlier version fails to open with `DocStoreError` `"schema"`, so open a new database name after you upgrade.
