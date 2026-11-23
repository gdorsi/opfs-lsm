---
"@opfs-lsm/tanstack-db": patch
---

A string bound and a lexical window follow TanStack's UTF-16 order. Before, `lt(s, "Ａ")` missed `"😀"`, and a lexical window could show the wrong first rows.
