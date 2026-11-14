---
"@opfs-lsm/tanstack-db": patch
---

An on-demand collection no longer reads every document when one live query is released while another loads its first page. It used to drop the released query's rows in the commit that delivered the other query's page. TanStack had already handed some of those rows to the loading query, so it saw them disappear before its load settled and asked for the whole collection. Rows that no live query keeps now leave memory once every load has settled.
