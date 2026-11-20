---
"@opfs-lsm/docstore": minor
---

`index(name, by, { include })` declares a sorted or multi index whose entries also hold the listed top-level fields of their document. `queryEntries` on that index returns each entry as `{ id, values, fields }`, with `fields` typed `Pick<T, ...>` and holding the included fields the document has. A list page that shows only those fields now costs one range scan, with no document read. Entries of other indexes and of the rows have no `fields`. The index takes more space, and a write that changes an included field rewrites its entries. Changing `include` under a higher `version` rebuilds the index. `IndexInfo` gains `include`.

The stored catalog format is now 2. A database written by an earlier version fails to open with `DocStoreError` `"schema"`, so open a new database name after you upgrade.
