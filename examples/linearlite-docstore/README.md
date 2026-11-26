# LinearLite on docstore

An issue tracker that lives in the browser only: a list, an issue page with edits, and new issues, built on [`@opfs-lsm/docstore`](../../packages/docstore) with kv underneath. There is no server and no sync. The views are [Solid 2.0](https://docs.solidjs.com) components. They read the app's state and the list's rows through Solid's `from()`, which turns a subscription into a reactive value. The docs site frames it on its home page. For the full app, with sync and a board, see [LinearLite on TanStack DB](../linearlite-tanstackdb).

```sh
pnpm --filter "@opfs-lsm/example-linearlite-docstore^..." build
pnpm --filter @opfs-lsm/example-linearlite-docstore dev
```

On first load it holds no issue. **Generate** makes 100,000 issues in a dedicated WebWorker (a background thread of the page), which hands them over in batches as it makes them. The page writes each batch in one transaction: 200 issues first, so the list has rows at once, then 2,000 at a time. The Data menu at the end of the toolbar holds two more actions. **Generate more** appends as many again, with new ids, beside the issues already stored, and a bar along the toolbar's bottom edge shows its progress. **Delete the data** destroys the database and reloads the page. `?count=` changes how many, and `?db=` names the database.

## Reads

An issue is one document, declared with a [valibot](https://valibot.dev) schema, and the document type is inferred from it. Four indexes serve the list, and every total is a count of index entries, which reads no document.

```ts
issues: collection(Issue)
  .text("byModified", "modified", "title")
  .index("byCreated", "created")
  .index("byStatus", ["status", "priority", "modified"])
  .index("byPriority", ["priority", "status", "modified"]),
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

Each edit of a title, a status or a priority is one `modify` of the issue. A new issue is two writes: its description, then the issue. Every write goes through the collection's schema, which rejects a document of another shape and stores nothing.

The list does not read again after a write. It listens to the collection's change feed (`changes`), which sends every written issue, from this tab or another. Each change gives the issue as it is now, and with `before` its entries in `byStatus` and `byCreated` before the write: its status, priority, modified and created times, which set its place in every list (`placeBefore` in `src/store.ts`). Every issue has an entry in both, so none means the write created it. The list takes the row out of its old place and puts it in its new one, and moves the total by one where the filter gains or loses the issue, whether or not it has read that row.

It reads the rows in view again and counts from the index entries in three cases: after a gap, during a title search, since no entry holds the title an issue had, and for a write of more issues than a page holds, which costs more to place one by one than to read.

Generated issues arrive through the same feed. While this tab writes them the list adds them to its total, and it reads the rows in view again after each batch.

`pnpm --filter @opfs-lsm/example-linearlite-docstore test` checks the list against the store, without the page: two handles on one database stand in for two tabs, and the list follows the other one's writes under each kind of read.

## Timings

The app times itself and posts each figure to the page that frames it (`src/protocol.ts`).

- **Open and read first rows** starts once the kv wasm module is loaded, at the call that opens the database. It ends when the store returns the first 50 issues, before they are drawn. A first visit and a reload measure the same work: open kv, open the document store, read the page.
- **Read a filtered page** starts when a filter, the sort or the search changes and ends when the store returns the first page of the new list, before it is drawn.
- **Write** is the time the transactions took, each from its call to its acknowledgement. The worker generates the next batches meanwhile.

## Telemetry

A build made with `VITE_EVERR_INGEST_ENDPOINT` set sends the timings and the browser's signals to Everr, as the service `opfs-lsm-demo` (`src/telemetry.ts`). `post()` turns each timing into one event, through the `KPIS` table in `src/protocol.ts`:

- `linearlite.open` from `opened`.
- `linearlite.first_rows` from `first-rows`.
- `linearlite.filter` from `filter`, with the read that served the list as `linearlite.read_path`. The search text stays out.
- `linearlite.write` from `generated`.

Each event carries its time as `linearlite.duration_ms`. A message type with no entry in `KPIS` fails the type check. `failed()` records each error the app catches once. To run the app alone against a local collector:

```sh
VITE_EVERR_INGEST_ENDPOINT=<otlp-url-from-status> pnpm --filter @opfs-lsm/example-linearlite-docstore dev
```

Telemetry stores nothing in the browser. The SDK keeps its session id in memory, so the id lasts for one page load, and the records cannot count visitors or follow one. A browser that sends Global Privacy Control or Do Not Track turns telemetry off, and `record()` and `report()` then do nothing. `src/telemetry.ts` posts each batch itself and first removes these attributes, which help tell visitors apart:

- `everr.visitor.id`
- `everr.screen.width` and `everr.screen.height`
- `everr.timezone`
- `browser.language`

The page URL keeps its query, which holds only `db`, `count` and `theme`. The docs site frames the demo without a referrer, so the query of the site's own address does not reach it. Each request still reaches Everr's ingest from the visitor's IP address, as any web request does, and the records still carry the user agent, the page URL and the referrer.

The docs site's README holds the configuration, the other events, why each attribute is removed, and the local and production setup, in [Telemetry](../../site/README.md#telemetry).
