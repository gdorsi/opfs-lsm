---
"@opfs-lsm/tanstack-db": patch
---

A `like` or `ilike` search on an on-demand collection finds a text stored in decomposed form, such as `"café"`, as the same search on an in-memory collection does. The text index holds words in NFC, so a pattern word reaches the index as a run of ASCII letters and digits without its last character, which a combining mark in the text can change. A search reads more index entries for it: `%bug%` reads the words that hold `bu`.
