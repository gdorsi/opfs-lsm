---
"@opfs-lsm/docstore": patch
---

A collection or index named like an `Object.prototype` member, such as `toString` or `__proto__`, throws `"schema"`. Before, it broke the open or lost the index. A text index's text field may hold `null`, which gives an entry with no words.
