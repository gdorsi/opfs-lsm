---
"@opfs-lsm/docstore": minor
"@opfs-lsm/tanstack-db": patch
---

Declare an index's fields with `by` instead of `on`, and mark an array field with a `[]` suffix instead of `multi: true`. For example, `{ on: "tags", multi: true }` becomes `{ by: "tags[]" }`. `defineSchema` now rejects a misspelled option such as `uniqe` at compile time, and opening a schema with an unknown option, `on` and `multi` included, throws `DocStoreError "schema"`. `IndexInfo.on` is now `IndexInfo.by`, with `[]` on the first field of a multi index. The stored catalog is unchanged, so existing databases open as before.
