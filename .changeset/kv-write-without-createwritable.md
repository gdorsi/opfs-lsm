---
"@opfs-lsm/kv": minor
---

The SharedWorker host now flushes and compacts in a browser with no `createWritable()`, as Safari and iOS 16 to 25, when it can write files another way. It stages each file as `<name>.crswap` through a sync access handle, flushes it, and renames it into place. The OPFS spec gives that handle to dedicated Workers only, so the worker first writes one scratch file in `opfs-lsm/` and stages its files only when the byte reads back. Where the scratch file fails, the host writes no file, as before. This ran in Safari 18.6 on macOS, from its SharedWorker, and in desktop Chrome inside a dedicated Worker. Safari 16 and 17 and iOS are untested. The host of a dedicated Worker, where the page has no SharedWorker, still writes no file. A page that imports `destroyDb` no longer bundles the file writer.
