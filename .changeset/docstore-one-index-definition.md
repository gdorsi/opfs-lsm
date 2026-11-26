---
"@opfs-lsm/docstore": minor
---

The stored catalog keeps each index as `indexes` describes it, with `kind` (`"sorted"`, `"multi"` or `"text"`), `by` as declared, `unique`, `text` and `include`. The declaration API and `IndexInfo` do not change.

The stored catalog format is now 4. A database written by an earlier version fails to open with `DocStoreError` `"schema"`, so open a new database name after you upgrade.
