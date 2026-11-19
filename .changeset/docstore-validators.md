---
"@opfs-lsm/docstore": minor
---

`collection(validator)` takes a Standard Schema validator (zod, valibot, arktype and others) in place of a type: `collection(Todo).index("byCreated", "createdAt")`. The documents are the validator's output, writes take its input, and `put`, `putMany`, `modify` and `modifyMany` store what the validator returns. A rejected document throws `DocStoreError` "invalid" with the validator's `issues` and the `ids` of the document, and so does a validator that returns a Promise, with no issues. Nothing is stored then. Reads never validate. A schema can mix validated collections and collections declared with `collection<T>()`. Validators are not stored: a change to one needs no `version` bump.
