---
"@opfs-lsm/kv": patch
---

The SharedWorker now removes every run file that the current generation does not list, on each compaction pass. Before, it listed the files once, so a file left by a failed compaction install or by a second SharedWorker on the same database stayed on disk until the worker restarted.
