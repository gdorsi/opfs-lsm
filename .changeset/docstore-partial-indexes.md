---
"@opfs-lsm/docstore": minor
---

`index`, `unique` and `text` take a `where` option that makes the index hold only some documents, as in `collection<Issue>().index("openByPriority", "priority", { where: { status: [0, 1, 2] } })`. A field maps to the value it must have, or to a list of the values it may have, and TypeScript checks the fields and the values against the document type. A document is in the index when every field of `where` holds one of its values. A missing field, an array or an object is outside, and `null` is a value that matches only when listed. A document outside the index has no entry, so it costs no write and no space, and a value the index cannot hold fails a write only for a document inside it. A list of open issues by priority is one range of the index, not one range per status. On a unique index, two documents can share a value when at most one of them is in the index. `where` goes with `include`. Changing it needs a new `version`, and the index is rebuilt with only the matching documents. `IndexInfo` gains `where`, the condition as sorted pairs of a field and its listed values.

The stored catalog format is now 3. A database written by an earlier version fails to open with `DocStoreError` `"schema"`, so open a new database name after you upgrade.
