---
"@opfs-lsm/tanstack-db": patch
---

An on-demand ordered, limited query whose load found fewer rows than its limit now lets rows go once writes fill it: it keeps the rows at or before the one at its limit, as a load would. It used to keep every matching row written after its load, so a list opened on an empty replica held every row a first sync wrote.
