---
"@opfs-lsm/kv": patch
---

`encodeTuple` and `stringPrefixBounds` write a string of up to 64 ASCII characters without a call to `TextEncoder`. The encoded bytes are the same for every string.
