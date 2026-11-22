---
"@opfs-lsm/docstore": patch
---

A write encodes its documents, and a read decodes them, in chunks of about 64 KiB of JSON: one `JSON.parse` and one `TextEncoder` or `TextDecoder` call per chunk instead of one per document. A short ASCII id or query word is encoded without a `TextEncoder` call. The stored bytes are the same. The documents of one change event are parsed together when a listener first reads any `doc`.
