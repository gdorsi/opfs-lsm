---
"@opfs-lsm/kv": minor
"@opfs-lsm/docstore": patch
---

`@opfs-lsm/kv/tuple` is a new subpath export. It encodes a tuple of null, booleans, finite numbers and strings as key bytes that sort in tuple order, decodes them, and returns the `KeyBounds` of every key that continues a tuple. To scan the keys under a tuple prefix, use `tupleBounds`. `prefixBound` also takes the keys of strings that continue the tuple with U+0000. The main `@opfs-lsm/kv` entry is unchanged. `@opfs-lsm/docstore` now imports this codec instead of carrying a copy, and writes the same key bytes.
