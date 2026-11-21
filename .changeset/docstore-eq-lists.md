---
"@opfs-lsm/docstore": minor
---

A slot of `eq` takes a value or a list of values: `issues.query({ index: "byStatus", eq: [projectId, ["todo", "started"]], reverse: true, limit: 50 })`. The page holds the documents of every listed value, in the order of the fields after `eq`, then by id, so the 50 most recently updated open issues are one query with no merge in the app. Several slots can hold lists, and each combination is one range, up to 64 combinations. A bound still applies to the field after `eq`, `after`, `reverse` and `offset` work as before, and a document found under two values of a multi index comes once. `queryEntries` gives each entry its own values, and the `fields` of a covering index. `count` returns how many results `query` would return. A list on a unique index or on the rows is a type error and a `DocStoreError` `"query"`. A cursor must be a result of the query: one whose value is not listed throws `"cursor"`.
