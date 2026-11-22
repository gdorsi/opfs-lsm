---
"@opfs-lsm/kv": patch
---

A database written without a 2 s pause is flushed once an eighth of `maxWalBytes` has waited 5 s, so a tab opened after a long typing session no longer replays up to `maxWalBytes` of small records.
