# LinearLite on kv: design

A Linear clone with LinearLite's feature set (list, board, issue detail, comments, filters, sort, title search,
create, a per-issue "not synced yet" mark) on TanStack Start, TanStack DB, `@opfs-lsm/tanstack-db` and SQLite.
It exists to show two things: how a local-first data layer shapes the UX, and what it costs at LinearLite's scale
of 100,000 issues with 0–1 comment each.

## The shape in one paragraph

kv on OPFS holds the whole replica in every browser. TanStack DB collections are the read model: issue summaries
are in memory in full, descriptions and comments only while a screen shows them. Every write, a local edit or a
row from the server, is one kv read-modify-write (`utils.transact`), so there is one write path and one merge
rule. Each row carries its own unsent edits (`dirty`), which is the "not synced" mark and the conflict guard. The
outbox is those rows, found by a live query over `dirty` issues and, because bodies and comments load on demand and
cannot be scanned, by small eager `outbox` marks naming the ones with unsent edits. One tab per browser, elected with Web Locks, talks to the server. The server is SQLite where every
row carries the global version that last changed it, so "what changed since V" is an index scan, not a log.

## Why the data is split (measured)

`bench/spike-100k.txt`: five alternating cold opens per side, 100k issues, fresh Chrome process each time.

| eager in memory | cold load (median, range) | tab heap |
|---|---|---|
| issue summaries only | 947 ms (776–1052) | 238 MB |
| summaries + descriptions + 49,734 comments | 1456 ms (1351–5623) | 437 MB |

Bodies and comments are 59 of the 81 MB of JSON, and nobody filters or sorts by them. They stay in kv and load by
key when a screen opens them. A profile of the summaries-only open shows no single limiter: TanStack ingest and
BTree index builds (~150 ms), kv's SST merge scan (~85 ms), JSON decode (~74 ms), GC (~50 ms), and ~210 ms waiting
on OPFS reads.

## Data

```ts
// src/domain/model.ts. Codes are numbers so `orderBy(priority)` sorts by meaning.
export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;  // code = index
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;           // code = index
export type StatusCode = 0 | 1 | 2 | 3 | 4;
export type PriorityCode = 0 | 1 | 2 | 3 | 4;

/** Field name -> local edit clock of an edit the server has not acknowledged. Absent = clean. */
export type Clocks = Readonly<Record<string, number>>;
/** `version` is the server version of the last server state merged in; 0 = never reached the server. */
export interface Synced { readonly version: number; readonly dirty?: Clocks }

export interface Issue extends Synced {      // eager, ~220 B
  readonly id: string; title: string; status: StatusCode; priority: PriorityCode; kanbanorder: string;
  readonly username: string; readonly created: number; modified: number; deleted: boolean;
}
export interface Body extends Synced { readonly id: string; description: string }   // on demand, by id
export interface Comment extends Synced {                                            // on demand, by issue
  readonly key: string;  // `${issue_id}/${id}`: "comments of X" is one kv prefix scan
  readonly id: string; readonly issue_id: string; body: string; readonly username: string;
  readonly created: number; deleted: boolean;
}
export type Stream = "issues" | "bodies" | "comments";
/** Eager, one per body or comment with unsent edits; the row itself still holds `dirty`. */
export interface OutboxMark { readonly key: string; readonly stream: "bodies" | "comments"; readonly rowKey: string; readonly nonce: string }
/** One eager row per browser (`id: "sync"`), written by the leader, read by every tab's status bar. */
export interface SyncState {
  readonly id: "sync"; epoch: string | null; cursors: Record<Stream, number>; head: number;
  online: boolean; caughtUp: Record<Stream, boolean>;
}
```

Server (`node:sqlite`, `data/linearlite.db`): tables `issue`, `body`, `comment` with the same fields as above plus
`version INTEGER NOT NULL` (indexed); table `meta(k, v)` holds `head` (the global version counter) and `epoch` (a
random id, so a client notices a reseeded server and starts over). Issues and comments carry `deleted`, and deletes
are tombstones. Bodies are 1:1 with issues and are never tombstoned: an issue's tombstone hides its body.

## One write path

`utils.transact(keys, merge)` (see Adapter features) runs `merge(currentRows)` inside one kv `db.update`, so nothing can
land between the read and the write, in this tab or another. Callers never use `collection.insert/update`.

| write | merge function (pure, `src/domain/merge.ts`) |
|---|---|
| local edit (`setStatus`, `move`, `rename`, …) | `applyLocal(row, patch, clock)`: patch the fields, stamp `dirty[f] = clock` |
| server row from a pull | `mergeIncoming(local, incoming)`: drop if `incoming.version <= local.version`; else take incoming, but keep every `dirty` field's local value |
| push acknowledgment | `mergeIncoming(local, row, ackedClocks)`: a dirty field whose clock equals the acked one is confirmed and cleared; a field edited again in flight stays dirty |

Each is idempotent: replaying a page or an ack converges to the same row. So a crash between writing a page and
advancing its cursor costs one re-pull, and no cross-collection transaction is needed. Deletes are
`deleted = true` plus `dirty`; the acked tombstone becomes a kv delete.

Hypothesis to check before the UI relies on it: a `transact` from a click shows in the same tab's live query
within one frame (the adapter applies kv's change event before the promise resolves). If it does not, the
commands wrap `transact` in a TanStack `createTransaction` for an optimistic overlay.

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
- **Loop.** On start, on every SSE hint, on a local edit (a live query over `dirty` rows) and on `online`:
  push every dirty row (fields = current values of dirty fields; a row with `version 0` pushes all fields with
  `create`), then pull each stream until `more` is false. Push before pull, so acked fields merge before the pull
  brings the same rows. Failure: back off 1 s → 30 s, mark `online: false`.
- **Outbox marks.** A command writes the mark, then the row. The leader reads the marked rows, pushes them, and
  removes a mark only if its `nonce` is unchanged, so an edit made while the push was in flight keeps its mark. A
  mark on a clean row (a crash between the two writes) pushes nothing and is removed.
- **Refused pushes.** A push the server refuses with a 4xx is retried op by op, so one bad op cannot wedge sync. An
  op still refused is dropped: the leader fetches that row from `/api/row` and replaces the local row with it,
  or deletes the local row when the server has none (a refused create). A field edited again while the push was
  in flight keeps its local value and stays dirty, so the next push sends it. It warns in the console.
- **First sync.** `issues` first, so list and board fill page by page; then `bodies` and `comments` in the
  background. A detail view opened before its body arrives calls `/api/detail` from its own tab and writes the
  result with the same `mergeIncoming`.
- **Pull order on a first sync.** Pages come in version order. The seed stamps versions newest `modified` first,
  so the first page is the default view's top rows and TanStack's sorted window appends instead of inserting at
  the front: `issues` caught up in 3.8 s instead of 6.9 s at 100k (`bench/first-sync-order.txt`). A real server's
  history arrives in write order, oldest first; it would need a bootstrap endpoint that pages by `modified desc`.
- **Conflicts.** Per field, the last push to reach the server wins. A local unsent edit beats any incoming value
  until it is acked.
- **Server push.** One SQLite transaction per request: bump `head`, apply each op's fields, stamp `version`,
  insert on `create`. Ops are field assignments, so a retried push is harmless and needs no dedupe table. The
  author of a created row is the `x-linearlite-user` header (absent: `anonymous`); there is no authentication.

## Adapter features the app uses (`@opfs-lsm/tanstack-db`)

```ts
interface KvCollectionUtils<T, K> {
  /**
   * Read `keys` and write in one kv `db.update`. `merge` gets the stored rows in key order (undefined = absent)
   * and returns one entry per key: a row to store, `null` to delete, `undefined` to leave as is. Resolves once the
   * collection shows the write: always when eager, for an on-demand collection only on keys a loaded plan covers
   * (other writes persist but stay out of memory). Throws if `merge` returns the wrong length or a row
   * whose key differs from its slot.
   */
  transact(keys: readonly K[], merge: (rows: ReadonlyArray<T | undefined>) => ReadonlyArray<T | null | undefined>): Promise<void>;
}

interface KvCollectionConfig<T, K> {
  /** Absent: eager, as today. Present: `syncMode: "on-demand"`; each loadSubset becomes kv reads per `plan`. */
  onDemand?: { plan(options: LoadSubsetOptions): { keys: readonly K[] } | { prefix: string } };
}
```

On demand: `loadSubset` runs the plan in one kv `view` (point gets, or one range over the string-key prefix),
commits those rows, and keeps the plan with a refcount. Change events commit only ops whose key some live plan
covers. `unloadSubset` releases a plan; rows no other live plan covers leave memory. A `gap` event reloads every
live plan. A plan that throws loads nothing, and the live query stays `loading` (an unbounded query on an on-demand collection is a bug).

Known, not fixed here: the adapter's `onUpdate` persists the row as the editing tab last saw it, so a tab with a
stale copy can erase a newer field another tab wrote. This app never calls `collection.update`.

## UX

- **URL is the only view state.** `?status=1,2&priority=0&q=sync&sort=modified&dir=desc` via `validateSearch`.
  List and board share it. Back and forward restore a view; a link reproduces it.
- **List.** `@tanstack/react-virtual` over a windowed live query (`orderBy` + `limit`, moved with
  `utils.setWindow`, TanStack DB's live-query API, not the adapter's) and a `count` query with the same `where` for the scroll height. BTree indexes on `status`,
  `priority`, `modified`, `created`, `kanbanorder`. Title search is `ilike` in memory; a query holding `%` or `_` uses a filter function instead, since `ilike` has no escape.
- **Board.** Five column queries ordered by `kanbanorder`, windows growing as a column scrolls, counts from one
  `groupBy(status)` query. A drop writes `status` and a fractional key between its neighbours in one `transact`.
- **Detail.** The summary is in memory, so the title and fields paint with the route. Description and comments
  load from kv on demand (a few ms) and, before backfill, from `/api/detail`.
- **Feedback.** A dot on rows with `dirty`; a status bar with `Syncing 42,000 / 100,000`, `Offline · 12 unsynced`
  or nothing when idle. Shortcuts: `c` new issue, `/` search, `j`/`k` move in the list, `Enter` opens, `Esc` back.

## Measuring

`bench/spike.sh` ran against a `/spike` route that has since been removed (last at commit f2a16a8); check that commit out to rerun it.

`bench/` drives Chrome as `bench/spike.sh` does, against a seeded server, at 10k and 100k issues, 5 alternating
runs, with the limiter named per number: first sync to first rows and to `issues` caught up, warm start to first
rows (offline), filter and sort change to rows, title search keystroke to rows, detail open, edit to visible in a
second tab, edit to acked, and tab heap.
