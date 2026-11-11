---
"@opfs-lsm/kv": patch
---

Reads of many keys at once are faster when the pages are not in memory yet. Page reads issued together are now served by one read per run of neighbouring pages. A docstore `getMany` of 3,000 ids on a cold cache is about 3.4 times faster in Chrome.
