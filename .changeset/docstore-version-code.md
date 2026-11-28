---
"@opfs-lsm/docstore": minor
---

Opening a schema whose `version` is stored with other collections or indexes throws `DocStoreError` code `"version"`, apart from the other `"schema"` disagreements, so a caller can tell "bump the version" from the rest without reading the message.
