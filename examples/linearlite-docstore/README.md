# LinearLite on docstore

An issue list that lives in the browser only, built on [`@opfs-lsm/docstore`](../../packages/docstore) with kv underneath. There is no server, no sync and no framework: plain TypeScript and the DOM. The docs site frames it on its home page. For the full app, with sync, a board and issue pages, see [LinearLite](../linearlite).

```sh
pnpm --filter "@opfs-lsm/example-linearlite-docstore^..." build
pnpm --filter @opfs-lsm/example-linearlite-docstore dev
```

On first load it holds no issue. **Generate** makes 100,000 issues in a dedicated WebWorker (a background thread of the page) and writes them in transactions of 2,000. `?count=` changes how many, and `?db=` names the database.

## Reads

An issue is one document. Four indexes serve the list, and every total is a count of index entries, which reads no document.

```ts
byModified: { on: "modified", text: "title" },
byCreated:  { on: "created" },
byStatus:   { on: ["status", "priority", "modified"] },
byPriority: { on: ["priority", "status", "modified"] },
```

| List | Rows | Total |
|---|---|---|
| By modified or created, no filter | One page of `byModified` or `byCreated`. A page deep in the list starts at a cursor reached by walking index entries without their documents. | Entries of that index. |
| By status or priority, with or without filters | One range of `byStatus` or `byPriority` per code, or per pair of codes under both filters, one after the other. | Entries of those ranges. |
| By modified or created, with a status or priority filter | Pages of the sort's index, filtered in memory, read only as far as the rows on screen. | Entries of the filter's ranges in `byStatus` or `byPriority`. |
| Title search | `byModified` with `match`: the titles holding every word of the query. A substring test, the filters and the sort run in memory. | The rows found. |

Only the rows in view are in the document, and only the pages scrolled to are read.

## Timings

The app times itself and posts each figure to the page that frames it (`src/protocol.ts`).

- **Open to first rows** starts at the app's call that opens the database and ends when the first page of issues is painted. It leaves out fetching and compiling the app's files, so a first visit and a reload measure the same work: open kv, open the document store, read 50 issues, paint them.
- **Filter to rows on screen** starts when a filter, the sort or the search changes and ends when the rows of the new list are painted.
- **Write** starts after the issues are generated and ends when the last transaction is acknowledged.
