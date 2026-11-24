---
"@opfs-lsm/kv": patch
"@opfs-lsm/docstore": patch
---

Smaller bundles: kv's main-thread JavaScript is 19.7 kB gzip, from 19.9 kB, and its SharedWorker chunk 13.4 kB, from 13.6 kB. The docstore chunk is 0.8 kB smaller before compression. Some docstore error messages changed with it: a `limit` or `offset` that is not valid says "must be an integer of at least 1" (or 0), a schema with a bad `include`, `drop` or text index reports one message for each, and a stored value that is not a JSON object reports "a stored value is not a JSON object". The error classes and codes are the same.
