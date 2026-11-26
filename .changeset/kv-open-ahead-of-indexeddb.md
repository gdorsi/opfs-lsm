---
"@opfs-lsm/kv": patch
---

`openDb` no longer waits for IndexedDB before it reads the manifest and opens the runs. While the WAL database opens, it reads the newest manifest in the folder and opens its runs, so a cold tab whose IndexedDB opens slowly resolves `openDb` sooner: a fresh-tab open of 100,000 entries went from 10.3 to 8.97 ms on an Apple M2 Pro. The main-thread bundle grows by about 150 gzip bytes, to 19.4 kB.
