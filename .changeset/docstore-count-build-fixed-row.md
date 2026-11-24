---
"@opfs-lsm/docstore": patch
---

A count index that is building no longer fails over a document that a write fixed during the build. The build marks the index failed only while the document still holds the value the index cannot hold, as a sorted index already did.
