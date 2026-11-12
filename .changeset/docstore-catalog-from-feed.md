---
"@opfs-lsm/docstore": patch
---

`get` and `getMany` no longer read the catalog from kv before each read. The store keeps its catalog current from kv's change feed and reads it again only after a `gap`. A read that runs while another tab's `clear` or schema change is still arriving on this handle answers from before that change, as a read just ahead of it would.
