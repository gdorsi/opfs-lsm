---
"@opfs-lsm/tanstack-db": minor
---

An on-demand collection now reads a text index for a query without a `like` on its text, as it reads a sorted index, so one text index can serve both a search and the plain order. Without a `match`, a sorted index that pins as many fields is still preferred. A load without `orderBy`, such as TanStack's load of the rows tied with a window's last row, takes among the indexes that pin the most fields the one with the fewest left unpinned. A text index holds only documents with a string at its text field: a document without one is not read through it.
