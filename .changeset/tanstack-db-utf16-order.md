---
"@opfs-lsm/tanstack-db": patch
---

An on-demand collection compares strings as TanStack DB does when they hold a character past U+FFFF or from U+E000 up. TanStack compares by UTF-16 code unit and an index by code point, so `gte(d.title, "😀")` missed `"｡"`, and a lexical `orderBy` with a `limit` could show the wrong first rows. A bound with such a string is now checked after the read, and a limited read whose rows hold one reads its ranges whole, as a locale-ordered read does.
