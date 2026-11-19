---
"@opfs-lsm/kv": patch
---

With `maxBytes: "quota"`, a flush that fails because the browser refused the write for lack of space now asks the `onPressure` handler to free space. Chrome 133 and later report a quota that is 10 GiB over the usage, so the 90% check never fired there.
