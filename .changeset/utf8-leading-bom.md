---
"@opfs-lsm/docstore": patch
"@opfs-lsm/fate": patch
---

A document id or a fate storage key that starts with U+FEFF now comes back with it. Reads, queries and scans used to drop the leading U+FEFF, because the UTF-8 decoder treated it as a byte order mark, so `"﻿a"` came back as `"a"`.
