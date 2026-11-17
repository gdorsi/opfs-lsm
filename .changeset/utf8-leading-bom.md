---
"@opfs-lsm/docstore": patch
"@opfs-lsm/fate": patch
"@opfs-lsm/automerge": patch
---

A document id, a fate storage key or an Automerge storage key segment that starts with U+FEFF now comes back with it. Reads, queries and scans used to drop the leading U+FEFF, because the UTF-8 decoder treated it as a byte order mark, so `"\uFEFFa"` came back as `"a"`.
