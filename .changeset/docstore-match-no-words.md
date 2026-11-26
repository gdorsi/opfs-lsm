---
"@opfs-lsm/docstore": minor
---

A `match` with no words, such as `""` or `" - "`, keeps every entry, as a query without `match` does. Before, it threw `DocStoreError` `"query"`, so a search box had to drop the option until the user typed a word.
