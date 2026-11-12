# LinearLite on kv: design

A Linear clone with LinearLite's feature set (list, board, issue detail, comments, filters, sort, title search,
create, a per-issue "not synced yet" mark) on TanStack Start, TanStack DB, `@opfs-lsm/tanstack-db` and SQLite.
It exists to show two things: how a local-first data layer shapes the UX, and what it costs at LinearLite's scale
of 100,000 issues with 0–1 comment each.

## The shape in one paragraph

kv on OPFS holds the whole replica in every browser, as `@opfs-lsm/docstore` collections with declared indexes.
TanStack DB collections are the read model, and every one that holds rows of a stream loads on demand: a screen's
live queries read the rows they show through those indexes, and nothing else is in memory. Counts are not
queries over memory either: the list total and the board's column counts count index entries in docstore. Every
write, a local edit or a row from the server, is one read-modify-write (`transact`), so there is one write
path and one merge rule. Each row carries its own unsent edits (`dirty`), which is the "not synced" mark and the
conflict guard, and a `pending: true` that a sparse index lists, so the outbox is a range read. One tab per
browser, elected with Web Locks, talks to the server. The server is SQLite where every row carries the global
version that last changed it, so "what changed since V" is an index scan, not a log.

## Why nothing is eager (measured)

`bench/spike-100k.txt`: five alternating cold opens per side, 100k issues, fresh Chrome process each time.

| eager in memory | cold load (median, range) | tab heap |
|---|---|---|
| issue summaries only | 947 ms (776–1052) | 238 MB |
| summaries + descriptions + 49,734 comments | 1456 ms (1351–5623) | 437 MB |

An eager collection reads, decodes and indexes every row before the list can paint, and holds them all. A
profile of the summaries-only open shows no single limiter: TanStack ingest and BTree index builds (~150 ms), kv's
SST merge scan (~85 ms), JSON decode (~74 ms), GC (~50 ms), and ~210 ms waiting on OPFS reads. Every term grows
with the replica. On demand, a warm start reads one index page of the list's 100 rows and counts 100,000 index
entries; see [Measured](#measured).

## Data

```ts
// src/domain/model.ts. Codes are numbers so `orderBy(priority)` sorts by meaning.
export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;  // code = index
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;           // code = index
export type StatusCode = 0 | 1 | 2 | 3 | 4;
export type PriorityCode = 0 | 1 | 2 | 3 | 4;

/** Field name -> local edit clock of an edit the server has not acknowledged. Absent = clean. */
export type Clocks = Readonly<Record<string, number>>;
/**
 * `version` is the server version of the last server state merged in; 0 = never reached the server.
 * `pending` is `true` exactly when `dirty` is present: no index can hold an object, a sparse one can hold `true`.
 */
export type Synced = { readonly version: number; readonly dirty?: Clocks; readonly pending?: true };

export type Issue = Synced & {               // on demand, ~220 B
  readonly id: string; title: string; status: StatusCode; priority: PriorityCode; kanbanorder: string;
  readonly username: string; readonly created: number; modified: number; deleted: boolean;
};
// src/client/store.ts. What kv holds: the fields plus the two sort keys, derived on every write (see Indexes).
export type StoredIssue = Issue & { readonly priorityOrder: number; readonly statusOrder: string };
export type Body = Synced & { readonly id: string; description: string };   // on demand, by id
export type Comment = Synced & {                                            // on demand, by issue
  readonly key: string;  // `${issue_id}/${id}`, from the server; the collection keys comments by `id`
  readonly id: string; readonly issue_id: string; body: string; readonly username: string;
  readonly created: number; deleted: boolean;
};
export type Stream = "issues" | "bodies" | "comments";
/** One eager row per browser (`id: "sync"`), written by the leader, read by every tab's status bar. */
export type SyncState = {
  readonly id: "sync"; format: number; epoch: string | null; cursors: Record<Stream, number>; head: number;
  online: boolean; caughtUp: Record<Stream, boolean>;
};
```

Server (`node:sqlite`, `data/linearlite.db`): tables `issue`, `body`, `comment` with the same fields as above plus
`version INTEGER NOT NULL` (indexed); table `meta(k, v)` holds `head` (the global version counter) and `epoch` (a
random id, so a client notices a reseeded server and starts over). Issues and comments carry `deleted`, and deletes
are tombstones. Bodies are 1:1 with issues and are never tombstoned: an issue's tombstone hides its body.

## One write path

`transact(store, stream, ids, merge)` (`src/client/store.ts`, over the adapter's `utils.transact`) writes
`merge(currentRows)` in one kv transaction, so nothing can land between the read and the write, in this tab or
another. For issues it stamps the sort keys from the fields `merge` returns, so no write leaves them stale. Callers
never use `collection.insert/update`.

| write | merge function (pure, `src/domain/merge.ts`) |
|---|---|
| local edit (`setStatus`, `move`, `rename`, …) | `applyLocal(row, patch, clock)`: patch the fields, stamp `dirty[f] = clock` and `pending` |
| server row from a pull | `mergeIncoming(local, incoming)`: drop if `incoming.version <= local.version`; else take incoming, but keep every `dirty` field's local value |
| push acknowledgment | `mergeIncoming(local, row, ackedClocks)`: a dirty field whose clock equals the acked one is confirmed and cleared; a field edited again in flight stays dirty; `pending` goes with the last dirty field |

Each is idempotent: replaying a page or an ack converges to the same row. So a crash between writing a page and
advancing its cursor costs one re-pull, and no cross-collection transaction is needed. Deletes are
`deleted = true` plus `dirty`; the acked tombstone becomes a kv delete.

A `transact` from a click shows in the same tab's list with no optimistic overlay: edit to live query 3.1 ms
p50, to DOM 3.5 ms (`visible`, production build, 60 edits).

**Write chunking.** kv caps one write batch at 10,000 ops. A docstore write of a row is one op for the row plus,
per index, at most a delete of its old entry and a put of its new one, so a row costs at most `1 + 2 × indexes`
ops. A pulled page of 2,000 rows is merged in slices of `floor(10000 / (1 + 2 × indexes))` rows, each its own
`transact`: 769 issues (six indexes), 3,333 bodies (one), 2,000 comments (two). The slice size is read from the
collection's `indexes`, so adding an index cannot push a page over the cap. Slicing loses nothing a crash could
not already lose: a merge is idempotent and the cursor advances only after the whole page.

## Sync

```
GET  /api/pull?stream=issues&after=V&limit=N  -> { rows, next, head, more, epoch }   rows ordered by version
POST /api/push { ops: PushOp[] }              -> { results: { stream, id, clocks, row }[], head, epoch }
GET  /api/events                              -> SSE, `data: {"head":N}` after every commit, ping every 25 s
GET  /api/detail?id=X                         -> { body, comments }   (a detail view opened before backfill)
GET  /api/row?stream=S&id=X                   -> { row, epoch }       one row, or null; comments by comment id
PushOp = { stream, id, fields: Record<string, unknown>, clocks: Clocks, create?: true }
```

- **Leader.** Every tab calls `navigator.locks.request("linearlite:sync", …)` and holds it for its life. The holder
  runs the loop; the next tab takes over from the cursors in kv when it closes. Other tabs only write local edits.
  kv's change feed is the bus between tabs; there is no tab-to-tab messaging.
- **Loop.** On start, on every SSE hint, on a local edit (a live query over `pending` rows) and on `online`:
  push every dirty row (fields = current values of dirty fields; a row with `version 0` pushes all fields with
  `create`), then pull each stream until `more` is false. Push before pull, so acked fields merge before the pull
  brings the same rows. The next page is asked for as soon as a page arrives, so it travels while this one
  merges; a push that sends anything drops it, so no pull brings rows from before a push. Failure: back off
  1 s → 30 s, mark `online: false`.
- **Outbox.** Issues, bodies and comments each have a sparse `pending` index, and the leader pushes the rows
  three live queries over `eq(pending, true)` read from it, a range of the unsent rows only. An ack clears just
  the fields whose clocks it confirms, so an edit made while the push was in flight stays pending. There is no
  separate outbox collection to keep in step with the rows.
- **Refused pushes.** A push the server refuses with a 4xx is retried op by op, so one bad op cannot wedge sync. An
  op still refused is dropped: the leader fetches that row from `/api/row` and replaces the local row with it,
  or deletes the local row when the server has none (a refused create). A field edited again while the push was
  in flight keeps its local value and stays dirty, so the next push sends it. It warns in the console.
- **First sync.** `issues` first, so list and board fill page by page; then `bodies` and `comments` in the
  background. An epoch change clears each collection with docstore's `clear`, one catalog write, and so does a
  `format` in the sync row other than the store's `FORMAT`, which changes when stored rows change shape; the leader
  pushes unsent edits before that clear. A detail view opened before its body arrives calls `/api/detail` from its
  own tab and writes the result with the same `mergeIncoming`.
- **Pull order on a first sync.** Pages come in version order. The seed stamps versions newest `modified` first,
  so the first page is the default view's top rows: the list's window fills from the first slice and then holds
  its 100 rows, and every later row sorts past it and stays out of memory. A real server's history arrives in
  write order, oldest first; the window would then take a newer row on most slices, which costs a TanStack
  update each, not memory.
- **Page size.** 2,000 rows per pull. 5,000 catches up about 1 s sooner at 100k but blocks the main thread up to
  ~400 ms per page late in the sync; 2,000 keeps each page under ~170 ms (`bench/client-100k.txt`).
- **Conflicts.** Per field, the last push to reach the server wins. A local unsent edit beats any incoming value
  until it is acked.
- **Server push.** One SQLite transaction per request: bump `head`, apply each op's fields, stamp `version`,
  insert on `create`. Ops are field assignments, so a retried push is harmless and needs no dedupe table. The
  author of a created row is the `x-linearlite-user` header (absent: `anonymous`); there is no authentication.

## Adapter features the app uses (`@opfs-lsm/tanstack-db`)

Every collection is `docstoreCollectionOptions({ collection, syncMode })` over an `@opfs-lsm/docstore` collection,
keyed by `id`. `issues`, `bodies` and `comments` are on demand; `sync` is eager, one row. `issues` sets
`defaultStringCollation: { stringSort: "lexical" }`, so the title sort reads its index in pages: the index orders
strings by code point, which agrees with TanStack's lexical compare for the seed's titles.

```ts
interface DocstoreCollectionUtils<T> {
  /**
   * Read `ids` and write them in one kv transaction (docstore's `modifyMany`). `merge` gets the stored documents in
   * id order (undefined = absent) and returns one entry per id: a document to store, `null` to delete, `undefined`
   * to leave as is. It may run more than once, first on what this tab last saw. Resolves once the collection shows
   * the write: always when eager, for an on-demand collection only for documents a loaded query matches. Throws
   * DocStoreError "document" if `merge` returns the wrong length or a document under another id.
   */
  transact(ids: readonly string[], merge: (docs: ReadonlyArray<T | undefined>) => ReadonlyArray<T | null | undefined>): Promise<void>;
}
```

On demand: `loadSubset` reads the query's rows through the collection's indexes in one docstore `view`: `eq(id)`
reads that document, `eq` and `inArray` on an index's leading fields read one range per value, and an ordered,
limited query reads the first rows of each range, in pages. A change event commits a document while some loaded
query keeps it; an ordered window keeps the rows at or before its last row, so the rows a first sync writes past
the list's window never reach memory. `unloadSubset` drops the rows no other loaded query keeps. A `gap` event
reloads every loaded query.

### Indexes

```ts
// src/client/store.ts
issues: {
  byCreated:  { on: ["deleted", "created"] },
  byTitle:    { on: ["deleted", "title"] },
  byPriority: { on: ["deleted", "priority", "priorityOrder"] },
  byStatus:   { on: ["deleted", "status", "statusOrder"] },
  search:     { on: ["deleted", "modified"], text: "title" },
  pending:    { on: "pending" },
},
bodies:   { pending: { on: "pending" } },
comments: { byIssue: { on: "issue_id" }, pending: { on: "pending" } },
```

Every list read pins `deleted = false`, so every ordered index leads with `deleted`: the adapter reads an ordered
window from an index whose leading fields the `where` pins and whose next field is the sort.

After every ordered, limited load TanStack loads the rows equal to the window's last row on the first order key,
with no limit; a second `orderBy` key does not narrow that load. About 20,000 issues share a priority or a status, so
the priority and status sorts order by keys that are unique per issue in practice: `priorityOrder` is
`priority × 10¹⁴ + status × 10¹³ + modified`, and `statusOrder` is the status digit followed by `kanbanorder`. Under
them the priority sort shows priority, then status, then `modified`, and the status sort shows the board's order.
Their indexes lead with the field itself, so a priority or status filter reads only its ranges; with no such
filter, the list pins every code, and the adapter reads one range per code and merges them.

| read | index |
|---|---|
| list sorted by modified, created or title, either direction, and its tie load (`eq(field, boundary)`) | `search` read without a `match`, `byCreated`, `byTitle`; a status or priority filter reads the same pages and filters them |
| list sorted by priority (`priorityOrder`), one range per priority, and its tie load | `byPriority` |
| list sorted by status (`statusOrder`), one range per status; a board column (`status = s`, by `statusOrder`) | `byStatus` |
| title search under the default sort | `search`: the entries holding every word of the query, newest first, then `ilike` in memory |
| title search under another sort | that sort's index, pages filtered by `ilike` |
| `useIssue(id)`, a detail fetch | the documents by id, no index |
| unsynced rows | `pending`, sparse: only rows with `pending: true` have an entry |
| list total, board column counts | `byStatus` per status; `byPriority` per priority, bounded by `priorityOrder` per status; `search` for a query |
| the sort value of row N of the unfiltered list, and the rows before it (deep scroll) | the sort's index, entries only, plus 65 documents |

Each index costs first-sync time and storage, about 240 ms of first sync per index at 100k issues: measured when
the collection had seven, a `byModified` among them, `issues` caught up in 4.2 s with all seven and in 3.3 s with
three of them (`byModified`, `byStatus`, `pending`) (`bench/first-sync-100k.txt`). It has six now. A missing
sort index costs more: that sort reads and holds all 100,000 issues, as an eager collection does. So every sort
keeps an index, and the default sort shares one with title search: `search` holds an entry per issue ordered by
`modified`, and the adapter reads a text index without a `match` as it reads a sorted one. Without a separate
`byModified`, issues catch up 540 ms sooner (`bench/first-sync-100k.txt`, section 4).

Known, not fixed here: the adapter's `onUpdate` persists the row as the editing tab last saw it, so a tab with a
stale copy can erase a newer field another tab wrote. This app never calls `collection.update`.

## UX

- **The URL holds the view.** `?status=1,2&priority=0&q=sync&sort=modified&dir=desc` via `validateSearch`.
  List and board share it. Back and forward restore a view; a link reproduces it.
- **List.** `@tanstack/react-virtual` over a windowed live query (`orderBy` + `limit`, moved with
  `utils.setWindow`, TanStack DB's live-query API, not the adapter's). No TanStack index: the collection holds a
  few hundred rows. Title search is `ilike`; a query holding `%` or `_` uses a filter function instead, since
  `ilike` has no escape.
- **Counts.** The scroll height and the toolbar total come from `countTotal` and the board's column counts from
  `countByStatus` (`src/client/counts.ts`), which count docstore index entries and read no document. A search
  counts the documents the `search` index matches whose title contains the query, so the total agrees with the
  list's `ilike`; a query of one plain word is counted from the index entries alone, which is exact for titles
  stored in NFC, as typed text is (the index normalizes, `ilike` does not). `useIssueRead` reads again after
  every change to issues, one read at a time, and waits four times the last read's duration, at least 250 ms,
  before the next. A first sync changes issues every few milliseconds, and counting 100,000 entries then takes
  up to a fifth of the main thread instead of half. A read after a change pauses between the statuses it counts,
  so a recount holds up no frame, in the tab that edited or any other visible one. A hidden tab paints nothing
  and wakes its timers about once a second, so it counts them all at once, as the first read for a filter does,
  since the screen waits on it. Counters kept from changes would save the 32 ms count itself, but
  every issue write would update one document, which a clear, an epoch change or a gap would have to recompute.
  The counts depend on the filter and the query, not the sort, so a sort change keeps them.
- **Deep scroll.** TanStack serves a window at offset N from the first N rows plus the window, and keeps them
  once the list scrolls back. So a window deep in the unfiltered list is its own live query, anchored at a sort
  value. `locate` (`src/client/counts.ts`) walks the sort's index to row N without reading documents, reads the
  64 rows before it, and returns row N's sort value and `base`, the rows that sort strictly before that value. The
  window's query keeps the filter's `where` plus `sort <= value` (`>=` ascending), so the adapter reads it from the
  sort's own index, and its rows sit `base` rows down the list. `base` is counted from the index again
  after every change, as the total is, so after a write that moves a row across the anchor the window is drawn
  one row off until that count returns: one frame in the `live` check of `bench/deep-jump-100k.txt`. A window
  within 1,000 rows past its anchor moves inside that query; one further down, or above the anchor, anchors again
  200 rows above its first row. Windows in the first 1,000 rows, every filtered list, and the list by title stay
  one query from the top, which TanStack loads as a prefix. Titles are left out because the index orders strings
  by code point and TanStack by UTF-16 unit: a title with an emoji and one with a character from U+E000 to U+FFFF
  come in opposite orders, so a row's place in the index is not always its place in the list.
- **Scroll.** The list keeps its scroll position per filter for the session, in memory, not in the URL, so Back
  from an issue lands where the user left.
- **Board.** Five column queries ordered by `statusOrder`, which is `kanbanorder` within a column, windows growing
  as a column scrolls, counts from `countByStatus`. A drop writes `status` and a fractional key between its
  neighbours in one `transact`.
- **Detail.** The summary is a live query by id: from the list's rows when they hold it, else one document
  read. Description and comments load from kv on demand (a few ms) and, before backfill, from `/api/detail`.
- **Feedback.** A dot on rows with `dirty`; a status bar with `Syncing 42,000 / 100,000`, `Offline · 12 unsynced`
  or nothing when idle. Shortcuts: `c` new issue, `/` search, `j`/`k` move in the list, `Enter` opens, `Esc` back.

## Measured

`node bench/client.ts <origin> <scenario>` drives headless Chrome against a production build (`vite build`,
`vite preview`) and a server seeded with `pnpm seed 100000`; `bench/ui-latency.js` times the list from the DOM alone
and counts a step only once the rows and the toolbar total are right, so one script times every build. Five runs per
build, one per build per round under a machine-wide lock; p50 (min–max) in ms. A is this app before issues moved to
docstore indexes (a631954, eager issues through the kv adapter), B this design, C the same app on TanStack DB's
SQLite persisted collection (`spike/linearlite-sqlite`), eager and on demand. The interaction rows for A and B are
round 2 of `bench/ui-latency-100k.txt`, C's are round 1; B's sort by priority and by status are from its "Sort keys"
section, and A and C were not timed on a sort by status. B's jump and heap rows are round 3, with deep windows
anchored at their row (`bench/deep-jump-100k.txt`), measured before the sort keys. B's first sync is from section 4
of `bench/first-sync-100k.txt`. Raw lines, commands and machine load are in
`bench/client-100k-prod.txt` and `bench/ui-latency-100k.txt`; what each read costs inside B is at the end of the
latter. Interaction times end at the next painted frame, so they move in ~16.7 ms steps.

| | A | B | C eager | C on demand | what limits B |
|---|---|---|---|---|---|
| warm start, first rows | 886 (876–898) | 106 (105–107) | 1,091 | 2,056 | main thread busy 89 of 116 ms in one trace (`bench/trace-warm.ts`, unminified build): opening kv and docstore and reading the first page 38, script 28, React 11 |
| warm start, rows and total | 888 (878–899) | 150 (150–152) | 1,093 | 2,056 | the total counts 100,000 `byStatus` entries, 32 ms |
| heap after warm start, MB | 139 | 25 | 119 | 134 | |
| storage, MB | 233 | 156 | 183 | 208 | |
| first sync, first rows | 139 (133–151) | 141 (125–162) | 212 | 212 | the first pull page |
| first sync, issues caught up | 2,417 (2,389–2,497) | 3,826 (3,689–4,141) | 9,940 | 11,121 | the index entries: kv's write path and docstore's index planning (`bench/first-sync-100k.txt`) |
| first sync, comments caught up | 5,713 (5,685–5,841) | 7,687 (7,493–8,503) | 13,345 | 14,474 | the same, for three streams |
| heap after first sync, MB | 322 (157–326) | 13 (10–23) | 181 | 190 | |
| status chip on | 28.3 (27.7–29.3) | 29.3 (19.9–30.3) | 42.6 | 1,088 | reads take ~8 ms of it: 431 documents to fill the window, 20k entries counted |
| status chip off | 96.1 (95.4–99) | 48.8 (47.2–59.5) | 190 | 146 | counting 100,000 entries, 32 ms |
| priority filter on | 27.1 (27–28.1) | 33 (29.5–45.5) | 39.9 | 1,109 | 585 documents read to fill the window (3 ms), 20k entries counted (7 ms) |
| sort modified ↔ created | 14.5 (13.5–15) | 14 (13.8–14.3) | 13.7 | 14 | one frame |
| sort modified → priority | 706 (700–709) | 15.2 (12.8–27.7) | 73.4 | 73.5 | one frame: the first 100 documents of each of five `byPriority` ranges, and one or two tied rows |
| sort modified → status | | 13.8 (13.5–16) | | | one frame: the same over five `byStatus` ranges |
| search keystroke (80 ms debounce) | 144 (142–145) | 123 (117–138) | 197 | 1,610 | the debounce, then the `search` entries for the word |
| list → detail, title painted | 14.5 (13.9–15.7) | 16.6 (16–17.9) | 59.6 | 127 | not the read: the live query by id finds the list's row at once (under 1 ms) |
| jump to row 5,000, first | 37.5 (37.1–58.7) | 50.6 (36.6–67.8) | 42.3 | 994 | walking ~4,800 index entries to the row, then a 100-row window; 158 before the anchor |
| jump to row 50,000, first | 343 (318–346) | 123 (121–129) | 198 | 1,188 | walking ~49,800 index entries: 110 ms the first time in a page, 31 after; 849 before the anchor, when TanStack loaded the first 50,100 rows |
| jump to row 50,000, later | 63.3 (60–87.1) | 85 (75.2–88.4) | 41.7 | 45.4 | the walk again and a new live query: no rows above the window stay in memory (15 before the anchor, when they did) |
| heap after the interactions, MB | 161 | 58 (53–109) | 141 | 153 | 700 issues held, 100 and 48 MB 12 s later once TanStack drops the deep window's query; the rest above the warm start's 25 MB is not broken down. 79 before the anchor, with the 50,058 rows the jump loaded |

Edits on B (`tabs`, `users`, `offline`, `visible`) all pass: an edit in one tab reaches the other tab's list in
2.2 and 1.8 ms p50 (each direction, n=10); another user's edit in 7 ms through the server; five edits made offline
are acked 330 ms after reconnecting; a tab's own edit reaches its DOM in 3.5 ms. The longest frame in the second
after an edit is 20 ms, against 19 ms on an idle page (`frames`, `bench/ui-latency-100k.txt`).

Where B is slower than A, and whose cost it is:

- **First sync**, 1.4 s later for issues and 2.0 s for comments. Each issue writes six keys instead of one (the
  document and an entry in five indexes; `pending` has none for a synced row), and each key is appended to kv's
  WAL, applied to its memtable and posted to other tabs, and the next merge reads the stored row back to plan the
  index changes. The two sort keys add about 100 bytes per issue to those writes and 610 ms to the sync. kv's
  broadcast posts every op even with no other tab open; that is kv's to change. Fewer indexes buy back ~240 ms each
  at the price of a sort that holds every issue.
- **Later jumps deep into the list**, 85 ms to row 50,000 against 63, and the first jump to row 5,000, 51
  against 38. B keeps no rows above its window, so each jump from the top walks the sort index to the row again
  (31 ms warm for 49,800 entries) and starts a new live query. The first jump to row 50,000 goes the other way:
  123 ms against 343.
- **Priority filter**, 33 ms against 27: B reads and counts what A already holds (above).
- **List → detail** is a wash: 16.6 against 14.5 ms here, 14.6 against 23.1 ms in round 1.

`bench/spike.sh` ran against a `/spike` route that has since been removed (last at commit f2a16a8); check that
commit out to rerun it.
