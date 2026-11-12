# LinearLite on fate: design

The same Linear clone as `examples/linearlite` (list, board, issue detail, comments, filters, sorts, title search,
create, delete, a "not synced yet" dot), with fate as the client data layer instead of TanStack DB. fate keeps a
normalized cache of what the screens fetched and a queue of offline mutations. Both persist through
`@opfs-lsm/fate`'s `kvStorage` on kv, or through fate's own IndexedDB storage with `?storage=idb`, so the two can
be compared on the same app.

## The shape

The server is SQLite behind one fate endpoint, `POST /api/fate`. The client asks for what a screen shows: one
window of the list, the board's columns, one issue. fate caches each answer by its arguments and persists the
cache, so a reload paints from the device and then revalidates (`stale-while-revalidate`). A write is one fate
mutation with an optimistic update. It is queued durably before the UI moves on, and fate delivers it with a
mutation id that the server records, so a retry after a lost answer is applied once.

The client holds only what was fetched. There is no replica, no sync stream and no live view: other tabs and other
users' changes show up when a screen revalidates.

## Data

`src/domain/model.ts` names the shapes: `IssueFields` (an issue's row), `IssueEntity` and `CommentEntity` (fate's
cache entities), the mutation inputs, and the request args (`FilterArgs`, `WindowArgs`, `ColumnArgs`). Status and
priority are codes 0 to 4, so sorting by them sorts by meaning.

Server tables (`data/linearlite-fate.db`, or `LINEARLITE_FATE_DB`):

- `issue`: the row fields plus `description`. Deletes are real deletes, and delete the issue's comments.
- `comment`: `issue_id`, `body`, `username`, `created`, indexed by `(issue_id, created, id)`.
- `receipt`: fate's mutation receipts, keyed by scope and mutation id.

`pnpm seed <count>` fills the database with the generator the original example uses.

## Lists are positional windows

A list request names the filter, the sort and a window: `{offset, limit}`. The offset is a multiple of 50 and the
limit is 150, so a scroll of a few rows keeps the same request and every window is a reusable cache entry. fate
reads `first`, `last`, `after` and `before` as its own paging and leaves `first` out of the cache key, so a window
uses its own names.

The list reads only the cache (`cache-only` in `useRequest`), which also restores a window from the device, and
fetches the window on its own (`stale-while-revalidate`). A window the user has visited therefore paints with the
server unreachable. A window that is not cached keeps the rows of the last cached window on screen and draws skeletons
at the rows it lacks, also when its fetch fails. The list never falls back to a loading screen while it scrolls, sorts
or filters, and shows "Loading…" only on its first load. The error and Try again appear only when there is nothing
to show: no cached window, or only windows under another filter or sort.

A window never reports `hasPrevious`. fate reads it as rows missing before the list and then does not count the list
as cached, so a list that reads only the cache would never paint that window.

Each sort has its own index: the sort columns, then `id`, then `status`, `priority` and `title` when the sort does
not already hold them. The query names it with `INDEXED BY`, so a filtered or searched window walks one index and
checks the filter in it, with no sort step and no row reads until the window's rows. SQLite's planner otherwise
picks the status index plus a temporary sort for filtered windows. A test asserts the plan for every sort.

## The board

Each column is a forward connection over `kanbanorder` (keyset on `(kanbanorder, id)`), 50 cards per page, and
grows by `loadNext` when it scrolls near its end. The board asks for the counts and all included columns in one
request, using `alias` for the five column roots. A filtered-out status has no column request.

## Counts

The counts are a value root (`clientValueRoot`) keyed by the filter: five numbers, one per status, from one
`GROUP BY status`. The list's total is their sum. They persist with the rest of the cache, so the total paints
offline.

## Writes

`src/client/commands.ts` keeps the original's command names. Each command is one durable mutation and resolves when
fate has persisted it on the device (`locallyPersisted`). The server's answer comes later, maybe after a reload; a
refusal rolls the optimistic change back and shows in the footer.

- Edits send only the changed fields; the server stamps `modified`.
- `createIssue` makes the id on the client, so a create and later edits of it can queue offline together.
- `createIssue` and `moveIssue` compute `kanbanorder` with fractional indexing between the neighbours on screen.
  A create whose column is not on screen leaves it out, and the server puts the issue at the top of its column.
- fate inserts a new item only into lists a mutation names. Screens register the lists they show (the list's first
  window under a newest-first sort, each board column, an issue's comments), and commands name those.
- The author is the `x-linearlite-user` header (`?user=` in the URL), else `anonymous`.

Positions in a window are the server's. An optimistic edit changes the row in place, and the screen refetches once
the server has answered a queued mutation, so a sort or count that depends on the edit catches up then.

## The server endpoint

`createFateServer` with custom `lists` (windows and columns), one `queries` entry (counts), a `byId` source for
issues that reads comments only when the view selects them, and four mutations. `node:sqlite` is synchronous and one
connection serves every request, so requests run one at a time, and a request with several operations runs them
one by one. fate runs a batch's operations together, which would interleave two mutations' transactions.

Receipts are scoped by the persistence key `linearlite`, which the client also uses. fate requires the two to
match.

## Persistence and sync status

`createPersistence({ key: "linearlite", storage })`. The default storage is `kvStorage(await openDb({ name }))`,
with the kv database name from `?db=` (default `linearlite`). `?storage=idb` uses `createIndexedDBStorage()`,
which opens an IndexedDB database named `fate`. The footer names the storage in use. The client is created in the
browser only, in the `_app` route's loader, behind a pending screen that the server renders into the page. The route
sets `pendingMinMs: 0`, so the screen goes away as soon as the open resolves.

The footer reads fate's persistence snapshot and `navigator.onLine`: offline, server unreachable (fate is retrying
a delivery), syncing, or idle, with the number of unsynced and failed mutations. A row or card shows the dot while
a queued or sending mutation names its issue.

## Left out

- Live views. fate's live transport needs a server push channel; screens revalidate instead.
- The original's `bench/` folder, except `bench/reload.ts`.

## Measured

`node` against a seeded 100,000-issue database, warm, in process:

- One list window at offset 49,950 under each sort: 2 to 5 ms.
- The request the list sends for that window (window plus counts): 8 to 10 ms.

Cold reload, `bench/reload.ts`, against `vite build` and `vite preview` with 10,000 seeded issues:

```
node examples/linearlite-fate/bench/reload.ts http://127.0.0.1:4181 --reps 7
```

For each storage the script scrolls 20 list windows in one Chrome profile so the cache holds a few thousand records,
then starts a new Chrome process on that profile 7 times, alternating kv and idb. Each start blocks `/api/fate`,
so the list can only come from the persisted cache. The script rejects a rep whose list total differs from the cached
one or whose API was reachable. On the last rep it also scrolls to a window that the prepare step visited and rejects
the rep unless that window's rows paint. It times, from navigation start, the marks `openFate` sets
(`fate:storage-open`, `fate:ready`), the first render of the app shell, and the first `.row[data-id]` in the DOM.

Result, median and range of 7 good reps per storage, 0 errors, on a machine with a load average of 5 to 6 on 18 cores:

| ms | kv | idb |
| --- | --- | --- |
| `fate:ready` | 78 (61-133) | 73 (52-96) |
| app shell | 82 (66-139) | 78 (57-105) |
| first list row | 135 (122-194) | 153 (133-217) |

No measurable difference: the ranges overlap, and the medians are 18 ms apart. A second run of 7 gave 124 ms
(109-366) on kv and 135 ms (112-176) on idb, with the same verdict.

The shell renders about 5 ms after `fate:ready` on both storages. `fate:ready` is the page load plus the storage open,
and idb opens its database on first use, so its open time sits inside that mark. The first row comes 55 to 75 ms
after the shell: fate reads the request's 152 records from the storage, then the list renders its rows. Four runs per
storage with a hook around fate's restore of the request put the read at 8 to 11 ms on kv and 35 to 69 ms on idb, and
the render after it at about 40 ms on both. kv's faster read is partly offset by a later `fate:ready` (5 and 14 ms later at the median in the two runs), so the
totals overlap.
