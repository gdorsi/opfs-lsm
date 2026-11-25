---
"@opfs-lsm/kv": minor
---

`openDb` takes `syncReads`, imported from the new entry `@opfs-lsm/kv/sync-reads`: `openDb({ name, syncReads })`. A tab then reads its SST files synchronously. A dedicated worker holds them open with read-only sync access handles and answers through a `SharedArrayBuffer`, so a read of a block that is not cached returns in the same task, where it otherwise waits for a round trip to the browser process. Cold reads in a fresh tab were up to about 2× faster in the tracker benchmark's goals. The option is Chromium-only and needs a cross-origin isolated page. Anywhere else the database opens and reads as it does without the option, with no error and no warning. Only an app that imports `@opfs-lsm/kv/sync-reads` bundles the code behind the option.
