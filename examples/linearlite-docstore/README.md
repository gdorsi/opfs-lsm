# LinearLite on docstore

An issue tracker that lives in the browser only: a list, an issue page with edits, and new issues, built on [`@opfs-lsm/docstore`](../../packages/docstore) with kv underneath. There is no server, no sync and no framework: plain TypeScript and the DOM. The docs site frames it on its home page. For the full app, with sync and a board, see [LinearLite](../linearlite).

```sh
pnpm --filter "@opfs-lsm/example-linearlite-docstore^..." build
pnpm --filter @opfs-lsm/example-linearlite-docstore dev
```

On first load it holds no issue. **Generate** makes 100,000 issues in a dedicated WebWorker (a background thread of the page) and writes them in transactions of 2,000. **Generate more** appends as many again, with new ids, beside the issues already stored. `?count=` changes how many, and `?db=` names the database.

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

An issue's description and comments are one document of a second collection, `details`, under the issue's id. It is generated from the id and stored the first time the issue is opened, so generating 100,000 issues writes no description.

## Writes

Each edit of a title, a status or a priority is one `modify` of the issue. A new issue is two writes: its description, then the issue.

The list does not read again after a write. It listens to the collection's change feed (`changes`), which sends every written issue, from this tab or another. For each one the list takes the row out of its old place and puts it in its new one, and moves the total by one where the filter gains or loses the issue. The feed says what an issue is now, not what it was, so the list uses the copy it holds: a row it has read, or the open issue. When it holds none, as after a write from another tab to an issue it never read, it reads the rows in view again and counts from the index entries.

Generated issues arrive through the same feed. While this tab writes them the list only adds them to its total, and it reads the rows in view once at the end.

## Timings

The app times itself and posts each figure to the page that frames it (`src/protocol.ts`).

- **Open and read first rows** starts once the kv wasm module is loaded, at the call that opens the database. It ends when the store returns the first 50 issues, before they are drawn. A first visit and a reload measure the same work: open kv, open the document store, read the page.
- **Read a filtered page** starts when a filter, the sort or the search changes and ends when the store returns the first page of the new list, before it is drawn.
- **Write** starts after the issues are generated and ends when the last transaction is acknowledged.
