---
"@opfs-lsm/kv": patch
---

An `update` whose body throws now throws only what the body throws at the committed head. The body ran on what its tab had read, which can lag another tab's write, and its error reached the caller as it was. A docstore `put` could then throw `"unique"` for a value another tab had freed a moment before.
