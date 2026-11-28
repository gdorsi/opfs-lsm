# LinearLite on docstore

An issue tracker that lives in the browser only: a list, an issue page with edits, and new issues, built on [`@opfs-lsm/db`](../../packages/db), which stores its documents through docstore and kv. There is no server and no sync. The views are [Solid 2.0](https://docs.solidjs.com) components that read live queries through the library's Solid adapter, `useLiveQuery`. The docs site frames it on its home page. For the full app, with sync and a board, see [LinearLite on TanStack DB](../linearlite-tanstackdb).

```sh
pnpm --filter "@opfs-lsm/example-linearlite-docstore^..." build
pnpm --filter @opfs-lsm/example-linearlite-docstore dev
```

On first load it holds no issue. **Generate** makes 100,000 issues in a dedicated WebWorker (a background thread of the page), which hands them over in batches as it makes them. The page writes each batch in one transaction: 200 issues first, so the list has rows at once, then 2,000 at a time. The Data menu at the end of the toolbar holds two more actions. **Generate more** appends as many again, with new ids, beside the issues already stored, and a bar along the toolbar's bottom edge shows its progress. **Delete the data** removes the database, and every tab that has it open starts over. `?count=` changes how many, and `?db=` names the database.

## Data

`src/model.ts` declares the two collections. An issue is one document, validated by a [valibot](https://valibot.dev) schema, and the document type is inferred from it. Each order of the list has an index on the fields that order sorts by. One table lists those fields, and both the indexes and the queries read it.

```ts
const SORT_FIELDS = {
  modified: ["modified"],
  created: ["created"],
  status: ["status", "priority", "modified"],
  priority: ["priority", "status", "modified"],
} as const satisfies Record<Sort, readonly (keyof Issue)[]>;

issues: collection(Issue)
  .text("byModified", SORT_FIELDS.modified, "title")
  .index("byCreated", SORT_FIELDS.created)
  .index("byStatus", SORT_FIELDS.status)
  .index("byPriority", SORT_FIELDS.priority),
details: collection(Detail),
```

An issue's description and comments are one document of `details`, under the issue's id. It is generated from the issue and stored the first time the issue is opened, so generating 100,000 issues writes no description.

## Reads

The list is queries built from the filter (`src/list.ts`): one per page of 50 rows, and one for the total. A page orders by the fields `SORT_FIELDS` gives its sort.

```ts
function matching(q: QueryRoot, issues: Issues, filter: Filter) {
  let list = q.from({ i: issues });
  if (filter.status.length > 0) list = list.where(({ i }) => inArray(i.status, filter.status));
  if (filter.priority.length > 0) list = list.where(({ i }) => inArray(i.priority, filter.priority));
  if (filter.q !== "") list = list.where(({ i }) => ilike(i.title, `%${filter.q}%`));
  return list;
}

export function pageOf(issues: Issues, filter: Filter, page: number) {
  return query((q) => {
    let list = matching(q, issues, filter);
    for (const field of SORT_FIELDS[filter.sort]) list = list.orderBy(({ i }) => i[field], filter.dir);
    return list.offset(page * PAGE).limit(PAGE);
  });
}

export const totalOf = (issues: Issues, filter: Filter) => query((q) => matching(q, issues, filter).count());
```

The library plans each query on the declared indexes. `explain()` on a query shows its plan.

| List | A page | The total |
|---|---|---|
| No filter | The sort's index, in order. The rows before the page are passed over as index entries, without their documents. | Entries of `byCreated`, counted. No document is read. |
| Status or priority filter whose fields lead the sort's index | One range of `byStatus` or `byPriority` per value, one after the other, passed over the same way. | Entries of the filter's ranges, counted. No document is read. |
| Any other status or priority filter | The sort's index in order, keeping the issues the filter lets through, as far as the page's last row. | Entries of the filter's ranges, counted. |
| Title search by `modified` | `byModified` through the words of the query, keeping the titles that hold it. | The titles found through those words, counted. |
| Title search under another sort | The sort's index in order, keeping the titles that hold the query. | As above. |

The view (`src/issues.tsx`) draws only the pages scrolled to. Each page in view is a component that subscribes to its own query, and shows placeholders until its rows are read.

```tsx
function Page(props: { app: App; at: number; from: number; to: number }) {
  const rows = useLiveQuery(() => props.app.page(props.at));
  return (
    <Repeat from={props.from} count={Math.max(0, Math.min(props.to, rows().length) - props.from)}>
      {(i) => <Row at={props.at * PAGE + i} issue={rows()[i]!} app={props.app} />}
    </Repeat>
  );
}
```

`props.app.page` reads the filter, a signal, so a change of filter moves each subscription to the new query. `from` and `to` are the part of the page in view. A row element stays at its place and shows the issue there. The rows are matched by id, so an edited title redraws one text node.

## Writes

Each edit of a title, a status or a priority is one `update` of the issue. A new issue is two inserts: its description, then the issue. Every write goes through the collection's schema, which refuses a document of another shape and stores nothing.

No code tells the list about a write. The library reruns the queries a write may change, whether this tab or another made it: an issue that enters, leaves or moves within a page in view reruns that page, and one that enters or leaves the list reruns the total. The issue page is a query by id, so it follows the same writes, and a deleted issue closes it.

Generated issues arrive the same way: after each batch the pages in view and the total are read again.

`pnpm --filter @opfs-lsm/example-linearlite-docstore test` checks the queries and the writes without the page (`src/list.test.ts`). `openMemoryDatabase` from `@opfs-lsm/db/testing` opens two handles on one database, which stand in for two tabs: the pages and the total of one follow the other's writes, under each kind of filter, and are compared with a filter and a sort over every stored issue.

## Timings

The app times itself and posts each figure to the page that frames it (`src/protocol.ts`).

- **Open and read first rows** starts once the kv wasm module is loaded, at the call that opens the database. It ends when the library hands over the first 50 issues, before they are drawn. A first visit and a reload measure the same work: open the database, read the page and count the list.
- **Read a filtered page** starts when a filter, the sort or the search changes and ends when the library hands over the first page of the new list, before it is drawn.
- **Write** is the time the transactions took, each from its call to its acknowledgement. The worker generates the next batches meanwhile.

## Telemetry

A build made with `VITE_EVERR_INGEST_ENDPOINT` set sends the timings and the browser's signals to Everr, as the service `opfs-lsm-demo` (`src/telemetry.ts`). `post()` turns each timing into one event, through the `KPIS` table in `src/protocol.ts`:

- `linearlite.open` from `opened`.
- `linearlite.first_rows` from `first-rows`.
- `linearlite.filter` from `filter`, with the index the first page read through as `linearlite.read_path`, from the query's `explain()`. The search text stays out.
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
