---
"@opfs-lsm/kv": patch
---

A write and a `get` find a key in the memtable by comparing numbers. A chunk of rows holds six bytes of each key beside it as one number, taken after the prefix its keys share, and a search reads a key only where two of those numbers are equal. It read a row's key at every step, about fifteen per search. The first keys of the chunks are searched the same way, and a chunk holds up to 128 rows instead of 1,024, so an insert moves an eighth of what it moved.
