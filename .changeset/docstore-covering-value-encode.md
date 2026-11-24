---
"@opfs-lsm/docstore": patch
---

A write builds the value of a covering index entry about twice as fast: its fields are written from an ordinary object, which `JSON.stringify` handles several times faster than one with no prototype, and the text is encoded into a shared buffer instead of one `TextEncoder.encode` allocation per entry. A put of one document encodes it the same way. The stored bytes are the same.
