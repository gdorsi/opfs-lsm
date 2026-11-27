# Benchmarks

`pnpm bench` runs every workload on every contender of its family in real headless Chrome. Each run gets a fresh browser profile. Runs are interleaved: rep 1 of every contender, then rep 2, with the contender order rotated each rep and, after as many reps as there are contenders, reversed, so no contender always follows the same other one. The defaults are size `small` and 5 reps.

```sh
pnpm bench                                   # everything, size small, 5 reps
pnpm bench kv/                               # one family
pnpm bench kv/fillrandom kv/ycsb-a --size large --reps 7
pnpm bench yjs/ --contenders kv              # one contender
pnpm bench kv/ --reps 5 --seed 7             # the same runs on another seed (default 1)
pnpm bench kv/ --timeout 600000              # the limit of one phase in ms (default 1800000)
pnpm bench:size                              # bundle sizes
pnpm bench:smoke                             # everything at size tiny, 1 rep
pnpm bench:smoke --check                     # what CI runs: the bundle-size budgets, the access-pattern owners, then the smoke and the byte budgets, from one run of the build
node bench/cli.ts compare results/a.jsonl results/b.jsonl [--all]
node bench/cli.ts report results/a.jsonl
node bench/cli.ts docs [--check]             # rewrite the results tables of docs/benchmarks.md; --check only compares
```

Run `pnpm bench:smoke` first whenever the code under test changed. A full `pnpm bench` takes tens of minutes, and a broken path can run it into the 30-minute timeout; the smoke finds that in about a minute. Pass workload selectors as separate words, not one quoted variable: zsh does not split `$SEL`, so `pnpm bench $SEL` with `SEL="kv/ tracker/"` matches nothing.

Results go to `bench/results/<time>-<cpu>.jsonl` (one record per run) and a Markdown table next to it. They are not committed, except a run whose numbers [docs/benchmarks.md](../docs/benchmarks.md) publishes, which goes to [docs/results/](../docs/results/). To compare a change, run the same selection before and after on one machine and use `compare`. It compares every number both files hold: ops/s, wall time, the mean latency of each op, the main-thread cells, amplification and memory peaks. Each number is one value per run, shown as the median with its min–max range. `compare` calls a difference when an exact rank-sum (Mann-Whitney) test of the two files' runs gives a two-sided p below 5%, and it knows which way is better: more ops/s, less time or memory. The test uses the order of the values, not their size: a wild run counts as one rank, however far off it is, and tied values share their ranks. Some run counts can never give a p below 5%: 3 against 3 gives 10% at best, and 4 against 4 is the smallest equal pair that can. Such a pair never shows a difference, and `compare` prints one line that counts those series. A second line says how many of the other series chance alone would mark at the 5% level (a series whose runs all hold one value, the same on both sides, can never be marked and is left out), since `compare` tests hundreds of series without correction and a few marked rows may be noise. When a file's runs overrode a kv option, `compare` says so above the table. It prints the rows with a difference and counts the rest. `--all` prints every row. A `†` marks a side of 5 runs or more whose runs fall into two clusters, so its median hides two states. `report` prints both clusters under the phase table, and the settled LSM layout in the amplification table.

`--seed N` (default 1) seeds every op stream, the tracker history and the curated goal bindings, so a run on another seed puts another order of writes, other read and update targets and another history through the same code. It does not change the key set of the kv workloads, which is the ids 0 to N−1 with each value derived from its id. It does not change the editing traces of `automerge/trace` and `yjs/trace`, which are recorded data, or the fixed notes of the `many-docs` workloads. With `smoke --check`, another seed skips the byte-budget rows above size `tiny`. The published tables and the [byte budgets](#byte-budgets) are for seed 1, so `docs` refuses a run on another seed. A `compare` means something only between two files on the same seed. It says so above the table when the seeds differ, and `report` prints a seed other than 1 under the host line.

Set `CHROME_PATH` when Chrome is not at the macOS default or on `PATH` as `google-chrome`.

## Publishing a run

The results tables of [docs/benchmarks.md](../docs/benchmarks.md) are generated. Each sits between `<!-- bench:table <id> -->` and `<!-- /bench:table -->`. `docs-tables.ts` names the run each table reads and the series each cell takes. A cell is the median of one series. A ratio comes from the same test `compare` makes, and gets a `‡` when the runs do not separate the two (see above). `docs` refuses a cell of fewer than 4 runs, so no ratio is of run counts that could never be separated, and a ratio without a `‡` is one the test separated. It also refuses a table that reads a workload and contender with a failed run in the file. A `†` marks a cell whose runs fall into two clusters. Only a cell of 5 runs or more is checked for them, and a table with a smaller cell says so. Under each table the command writes the run counts, the Chrome version, the CPU, the load average, the commit and a link to the full results.

To publish a run:

1. Run the benchmark from a clean tree, with at least 4 reps (the default is 5). `docs` refuses a run that recorded `-dirty`.
2. Copy its `.jsonl` and `.md` from `bench/results/` to [docs/results/](../docs/results/).
3. Set the table's `file` in `docs-tables.ts` to the new stamp.
4. Run `node bench/cli.ts docs`, and commit the page with the run.

A new row or table is an entry in `docs-tables.ts` and, for a table, a pair of markers in the page. The command fails on a marker with no table, a table with no marker, and a cell with no series. `docs --check` needs no Chrome and no build. `pnpm check:docs` runs it, so CI fails when a table differs from its run. The Bundle size table does not come from a result file, so it stays by hand.

## Families

| family | ours | baseline |
|---|---|---|
| `kv` | kv (`openDbWith` of `@opfs-lsm/kv/testing`: `openDb` on the SharedWorker that keeps host counters) | a hand-written IndexedDB key-value store: one object store, one transaction per batch with an explicit `commit()`, `getAll` pages for scans, with `direction: "prev"` for reverse ones, `delete` of a key range for a range delete |
| `tanstack` | `docstoreCollectionOptions` from `@opfs-lsm/tanstack-db` (`packages/tanstack-db`), eager, over a docstore collection with no indexes | TanStack DB's `indexedDBCollectionOptions`, eager, its only mode |
| `tanstack-ondemand` | `docstoreCollectionOptions` with `syncMode: "on-demand"` over a docstore index on `[owner, createdAt]` | TanStack DB's `@tanstack/browser-db-sqlite-persistence` (wa-sqlite on OPFS), on-demand, with `createIndex` on `owner`, `createdAt` and `id` and the adapter patch described below |
| `automerge` | `@opfs-lsm/automerge` (`packages/automerge`) | automerge-repo's `IndexedDBStorageAdapter` |
| `yjs` | `KvPersistence` from `@opfs-lsm/yjs` (`packages/yjs`) | y-indexeddb |
| `tanstack-query` | `createQueryPersister` from `@opfs-lsm/tanstack-query` (`packages/tanstack-query`), TanStack Query's per-query persister on kv | idb-keyval as TanStack's docs use it, with `get`, `set`, `del` and `entries` on a `createStore` store under `experimental_createQueryPersister` |
| `tracker` | `docstore`: docstore on kv, a collection per entity and the indexes its goals need, three of which include the fields of an issue card, so the status page, a person's issues and the recent issues read no issue document | `dexie`: Dexie 4 with compound indexes and no multi-entry index (its `labelPage` walks the project's issues newest first and tests their labels, which reads more rows than a label index for a rare label in a big project and fewer otherwise, and its writes keep no label index; its `search` scans a `[projectId+updatedAt+title]` index by key, as SQLite's covering index does, and reads only the rows that match); `sqlite`: wa-sqlite on OPFS in a dedicated worker, normalized tables, plain SQL (its `labelPage` joins the `issue_labels` table, and SQLite's planner answers it with Dexie's walk: the project's issues newest first, each probed in `issue_labels` by its primary key; an index on `labelId` does not change that plan; its card lists read each issue row after the index, where docstore's three card indexes include the card's fields: SQLite indexes that cover those lists trade slower writes and a larger database for faster lists, measured in [docs/research/sqlite-covering-indexes.md](../docs/research/sqlite-covering-indexes.md), and the contender keeps plain indexes) |
| `tanstack-live` | `kv`: `docstoreCollectionOptions`, eager; `kv-ondemand`: on demand over compound docstore indexes that end in each screen's sort field | `indexeddb`: `indexedDBCollectionOptions`, eager; `sqlite`: TanStack's SQLite persistence, on demand, set up as in `tanstack-ondemand` |

Every contender uses its library's fast path, and the report prints that path and the durability next to the numbers. kv's WAL commits with IndexedDB's default durability (relaxed in Chrome since version 121), so the IndexedDB baselines use the default too. Every contender runs its library with its default settings, except that kv opens with `reserveBytes: 0`: its default reserve is 24 MiB of written bytes that hold no data, so it would count in the disk bytes and Space-Amp of every run, and its one write would land in a timed phase. SQLite keeps `synchronous=FULL` and its default page cache, so its commits wait for the disk where IndexedDB's relaxed default does not.

The SQLite contenders run TanStack's adapter with a patch, [`patches/@tanstack__db-sqlite-persistence-core@1.0.0-rc.1.5.patch`](../patches/@tanstack__db-sqlite-persistence-core@1.0.0-rc.1.5.patch). As it ships, the adapter sends no `LIMIT` to SQLite and never filters on a number in SQL, so a window of 50 rows reads every row its `where` matches. The patch sends `LIMIT`, `OFFSET`, and `eq` and `in` on numbers to SQLite when its SQL selects exactly the rows the `where` keeps. It accepts a filter made of `eq`, `in`, and `gt`, `gte`, `lt` and `lte` against a number. The range tests cover the page query of `tanstack-ondemand`, which filters on `gte(createdAt)`, and the load that refills a live query's window from its last row, which TanStack sends as the screen's filter plus `lt` or `gt` on the sort field. Without them a refill read every row past that row: with the four screens of `tanstack-live` open, every sync batch reloaded nearly every issue. The patch assumes that a field compared with a number holds a number or null in every row, which is true for every SQLite workload here.

## Workloads

The kv workloads follow RocksDB's db_bench and YCSB. Keys are 16 bytes and values 100 bytes, half compressible (LevelDB's setup). Sizes are `tiny` 1,000 entries, `small` 100,000 and `large` 1,000,000.

- `kv/fillrandom`: N/100 single puts (at least 100), each awaited, on the empty store (db_bench's fillsync); a random fill; random reads while compaction still runs (`readrandom-unsettled`); after the settle and one untimed scan of every key, random reads and reads of missing keys over warm pages (`readrandom`, `readmissing`; a missing key is a stored key plus one byte, so it falls between two stored keys, as in db_bench); a cold open (5 fresh tabs, each opening the db and getting one random key, so a run has 5 samples of each); the same random reads in the last of them, which loads each page once (`readrandom-cold`); then deletes of a random tenth. Before the settle, `readrandom-deleted` reads random keys of the whole range, about a tenth of them tombstones that must come back missing, and `pagedeleted` walks the live keys in pages of 100 values, each page starting after the last live key of the page before, so a scan crosses the fresh tombstones. A page counts as one op. Then the space before and after compaction. `readrandom-unsettled` races compaction, so its runs can form two clusters: when compaction ends early, the phase pays the page loads of the new files. The deletes run in the cold-open tab, whose counters start there, so the W-Amp on that settle divides compaction bytes by the delete keys alone: read its Space-Amp and disk bytes, not its W-Amp.
- `kv/fillseq`: ascending fill, a full scan, random seeks of 10 and 100 keys, reverse seeks (`seekreverse`: the 100 values below a random key, in descending order), scans bounded above with a limit past the bound (`scanbounded`: 50 keys, limit 100), counts of a tenth of the keys, pages of 50 values an offset deep (`skip`, and `skipreverse` in descending order below a random key), and reads of 50 scattered keys in one call. `deleterange` then deletes a tenth of the keys as 100 ranges, one write each. Before compaction, `readdeleted` gets random keys, a tenth of them deleted, and `pagedeleted` reads a page of 50 values from the start of each deleted range. `check-deleted` repeats both untimed after a settle.
- `kv/ycsb-a`: YCSB A (50% reads, 50% blind updates), then after a settle YCSB F (50% reads, 50% read-modify-writes in one transaction), then an untimed read of every key (`check-after`), so the last write to each key is checked too. Zipfian, as in YCSB's workload files: its ScrambledZipfianGenerator, theta 0.99 over 10^10 items with YCSB's precomputed zeta, hashed with its FNV onto the keys, so the hottest key takes 3.8% of the draws at any size. Pebble uses the same letters for different mixes.
- `kv/two-tabs`: a random fill and a settle in the first tab, which keeps the store open. `open-second` times the second tab opening the store while the first tab holds it (op `open`), then its first get. The first tab then overwrites a random tenth of the keys. `read-second` times the second tab catching up with the first tab's writes (op `sync`, counting 0 ops), then reading those keys back (up to `ops` of them), and every value must be the new one, so a stale read fails the run. kv copies the first tab's writes as its messages arrive, while the second tab is idle, so `sync` times one read of the end of the WAL and the writes that have not arrived by then. IndexedDB has nothing to catch up, and its `sync` is empty. On kv both tabs share one SharedWorker host. IndexedDB opens one connection per tab.
- `kv/large-values`: a random fill of 8 KiB values under 40-byte keys that differ in their last 4 bytes, the shape of a sync client's stored chunks, in batches of 200. Sizes are 200, 6,000 and 24,000 values. After the settle, 5 fresh tabs each read every value in reads of 500 neighbouring keys (`readall-cold`), as such a client loads the children of one tree node at startup, and 5 more read every value in reads of 500 keys from all over the store (`readscattered-cold`).
- `kv/compaction-memory`: 20 rounds of N random puts into a 4N key pool, settle, then checked reads. Run it for the memory peaks below, not for throughput.
- `tanstack/todos`: todo rows (title, done, owner, createdAt) through a TanStack DB collection: first insert, bulk inserts in transactions of 1,000, N/100 serial inserts, N/10 updates and N/10 deletes in transactions of 100, a reopen in a fresh tab before the settle (`reopen-unsettled`, which loads every row the deletes just changed), then a cold open (5 fresh tabs) that loads every row. Reads are TanStack's in-memory rows on both sides, so the timed work is persistence and load. Untimed `check-*` phases compare the whole collection with the model. It uses one tab at a time; two tabs on one database are in `kv/two-tabs`.
- `tanstack-ondemand/queries`: the same todo rows in an on-demand collection: bulk inserts, then a cold open (5 fresh tabs) and live queries that each load their own rows: every row of one owner, pages of 50 rows of one owner ordered by `createdAt`, and 10 rows by id. A query is timed from creating the live query to its first result, plus releasing it. The page and id queries each run on a fresh page that an untimed phase (`reopen-pages`, `reopen-ids`) opened the store on, so the timed phase holds no store open. They get one because TanStack's SQLite collection keeps every row it has loaded after a query is released, and the owner queries before them load every row. For the same reason the owner phase queries owners 1 to 15: the first query loaded owner 0. Updates run on rows held queries keep loaded: every owner's query opens before the first update and closes after the last, so no load counts in the phase's span. Every result is compared with the model. The check after the updates runs on the live rows, and `check-stored` runs it again on a fresh page, so it reads what reached storage. TanStack's `createIndex` takes one expression, so SQLite has no index on `[owner, createdAt]`.
- `automerge/trace`, `yjs/trace`: the LaTeX editing trace (about 260k keystrokes; 2,000 at `tiny`, 26,000 at `small`) through the persistence layer, and four steps after it:
  - `persist` writes the trace's head as fast as it goes. `yjs/trace` then pauses for 2 s, past the 1 s idle delay after which both Yjs libraries merge their stored updates, as a real document's history is merged.
  - `type` types its last 300 keystrokes (100 at `tiny`) at one per 60 Hz frame, one Yjs transaction or Automerge change each, with the main thread recorded. Typing is paced, so its wall time is the pacing: read the `key` latency, the frames and the `flush`. Yjs stores every update as it happens; automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing.
  - `reopen` opens the document cold in a fresh tab before kv settles, so the typed updates are still in the log or the newest runs.
  - `load` opens it cold again after the settle.

  The settle runs in the `reopen` tab, and kv counts writes per tab, so these workloads report no W-Amp.

  The trace downloads once into `bench/.data/`.
- `automerge/many-docs`, `yjs/many-docs`: many small notes written, then each loaded cold and compared whole (title and body) with what was written, outside the timers.
- `tanstack-query/cache`: a TanStack Query client caches list and detail queries of the tracker workspace, one entry per query through the per-query persister. `fill` (untimed) fetches and stores every query. `restore` restores the whole cache with `restoreQueries` in a fresh tab. `refetch` refetches 20 bursts of 10 queries, each burst timed until its writes are stored. Sizes are 124, 644 and 4,144 queries, about 0.2, 1.6 and 4.9 MB of JSON.
- `tracker/goals`: a task-tracker workspace built from its history, then 11 goals and one board of 6 reads, each on a fresh page; see [Goal workloads](#goal-workloads).
- `tanstack-live/screens`: what TanStack DB live queries cost an app on the tracker dataset; see [Live queries](#live-queries).

The TanStack Query workload builds the client, and a contender supplies only the per-query persister over its storage, so both run the same client code. The queries come from the tracker workspace after its history. A list query holds the first 50 issues of one project and status as cards, about 8 KB of JSON. A detail query holds one issue and its comments, about 0.7 KB, and the details are the most recently updated issues, the ones a user opened. `tiny` is the tiny workspace with 100 details. `small` is the small workspace with 500 details, the few hundred queries a busy user leaves in a cache whose persister keeps them 24 hours. `large` keeps the small workspace and opens 4,000 issues, so it scales the per-query costs. A burst of 10 queries is what one screen shows and a window focus refetches at once. The server is in memory and answers a query at the model's revision, so the timed work is TanStack's persister and the storage under it. `persisterFn` does not await its write, so the workload persists each query with `persistQueryByKey` once its fetch resolves. That call runs the same write as `persisterFn`, and a burst ends when every write of it is stored. Every restore compares every query with the model. `check-refetch` restores the cache again in a fresh tab, so a write that never reached storage fails the run. `node bench/probes/tanstack-query-storage.ts [workload] [--size small]` prints, per phase and contender, how much of the phase was in the persister's calls and how much was TanStack's own work, with the persister's JSON work shown on its own.

"Cold" means a new tab opened after every SharedWorker has exited and 3 s later: a cold page over warm OS storage. A page cannot drop the OS cache. Chrome keeps an origin's IndexedDB backing store open for 2 s after its last connection closes, and a tab that finds it open skips the open cost (1 ms against 19 ms for a 200k-row store). The wait outlasts that grace period, and only the first tab of a run touches storage, since a touch opens the backing store too. `smoke` skips the wait, because it checks answers and bytes, not times. One tab gives one cold sample, so a phase that wants more runs in several fresh tabs, as `rounds` (see [Adding a workload or contender](#adding-a-workload-or-contender)). The rounds add samples to each op: `mean:<op>` and the percentiles pool them. The phase's ops/s, wall time, main-thread cells and footprint stay those of its first round, so they mean the same as for a phase without rounds.

Every read is checked against the expected value. One wrong value fails the run, and a failed run never feeds a number.

## Goal workloads

A goal workload is a dataset plus questions a screen asks of it, the shape of TPC-H and LDBC SNB rather than of db_bench. A contender replays the dataset's history through its own write API and answers each goal with its own query API, the way its docs recommend. Every answer is compared whole with an oracle. The prior art and the reasons for this shape are in [docs/research/goal-driven-benchmarks.md](../docs/research/goal-driven-benchmarks.md).

`tracker/goals` runs on a task-tracker workspace: users, projects, labels, issues (status, priority, assignee, 0 to 3 labels) and comments. Sizes are 1,000 issues at `tiny`, 20,000 at `small` and 200,000 at `large`, with about two comments per issue. The history is a seeded simulation of the workspace. Projects, people and labels are zipfian, and actions favor recently created issues. Ids are random, so no index order follows key order.

The phases:

1. `replay` (timed): once 70% of the issues exist, that state is written as `import` batches of 1,000 rows of one entity, oldest change first. The rest of the simulation is written as `sync` batches of 50 events. Each event creates, patches or deletes one row. A patch carries the change, not the row, so the replica reads the stored row and folds the change in. After every 10th `sync` batch the replay reads the 50 most recently updated issues (op `read`, counting 0 ops), as a list on screen re-queries while a large sync lands, and checks them against the oracle at that point of the history. The replay's ops/s divides its ops by the whole span, so it includes the time of those reads.
2. `settle` (untimed): kv flushes and compacts until stable.
3. `recent` (timed): a `bulk` batch closes the sprint of the project with the most issues in progress, then single `edit`s (50 at `tiny`, 300 above), one user rename and one label rename. These writes sit above the settled store when the goals run. At `large` the sprint holds about 7,500 issues, more than one docstore write takes under kv's 8 MiB batch limit, so the docstore contender splits a batch into writes of 1,000 events. Dexie and SQLite commit it whole.
4. `prepare` (untimed): picks each goal's bindings, LDBC-style: up to 5 bindings whose cost in the oracle is nearest one quantile, the same for every rep and contender. A goal that returns a page of 50 rows (20 for `search`) takes that quantile among the bindings whose answer fills the page, when any do at that size, so the `LIMIT` cut and a merged top-N run. `drainedPage` fails when the history has no bulk edit that emptied a list. It computes every expected answer and carries them to the later pages.
5. One phase per goal, in 5 rounds, each on its own fresh page. Round r opens the store and calls binding r once: that is `cold`, so a run has one `cold` sample per binding. Round 0 then calls each other binding once (`first`) and every binding 3 more times (`warm`). A goal with fewer than 5 bindings leaves its last rounds empty.
6. `board` and `board-serial` (5 rounds each, as a goal): the reads a project's board fires as it opens. One burst is 6 calls: `statusCounts`, `statusPage` for each of the 4 open statuses, and `assigneeLoad`, on a project near the median count of open issues. `board` starts the 6 calls in one task and times from the first start to the last answer. `board-serial` awaits each call before it starts the next, on the same projects. A sample is one burst and counts 6 ops, and all 6 answers are checked. Compare the two phases: `board` well under `board-serial` means the store overlaps the reads, equal means it queues them, and `board` above `board-serial` means the reads contend.
7. `reread` (fresh page): each read once untimed, then one edit moves an issue from todo to in progress, and its status counts and both lists must show it.

| goal | the screen | owns |
|---|---|---|
| `statusCounts` | issues per status in a project | count over an index prefix, no row read |
| `statusPage` | first 50 todo issues of a project, newest update first, with assignee and label names | index page whose rows are scattered in key order, joined N:1 and M:N |
| `drainedPage` | the in-progress column of the project whose sprint just closed | index range a bulk edit nearly emptied (the answer is 1, 4 or 6 rows at tiny, small and large), above the settled levels |
| `deepWindow` | rows at 90% of a project's list by number | a deep window, passed over with `offset` |
| `issueThread` | issue `P3-1234` with its comments and their authors | two unique-key hops, then a 1:N child range joined to authors |
| `triagePage` | first 50 open issues by priority, each with its comment count | a child count per row of a page, over an IN-list |
| `labelPage` | first 50 open issues of a project with a label | a filter through a multi-entry index |
| `myIssues` | first 50 open issues assigned to a person, any project | an IN-list across every project, merged top-N |
| `recentActivity` | the 50 most recently updated issues | the newest end of a global time index under churn |
| `assigneeLoad` | open issues per person in a project, top 10 | a group-by count on a non-leading field, joined to names |
| `search` | first 20 issues of a project whose title contains a word | a substring match no equality or range answers |

The rules for a contender:

- It stores the rows as the history gives them, plus any index its library declares natively. It keeps no app-maintained derived state: no counters, no copied names, no cached answers.
- A goal gets its library's handles and its parameters, nothing else.
- A goal sees every write acked before it started. `reread` checks this.

Contenders import only the dataset's `types.ts`. oxlint keeps the history and the oracle out of contender code, and keeps contender code and storage libraries out of the dataset.

## Live queries

`tanstack-live/screens` measures what TanStack DB live queries cost an app on top of a store. It runs on the tracker dataset, at its sizes, and checks answers against the tracker's oracle.

Four tracker goals are one screen each: `statusPage`, `labelPage`, `myIssues` and `recentActivity`. Each is a live query built with TanStack's query builder: the issues the screen lists, left-joined to their project (for the key) and assignee (for the name), newest update first, 50 rows. Label names come from one live query of all labels, mapped by id, because TanStack joins only on equality and a card holds an array of label ids. Every join is a left join: TanStack loads a window in order from an on-demand collection only when no join can drop a row. Each screen subscribes to its query, as `useLiveQuery` does. TanStack collects a live query that has no subscriber after 5 s.

The two on-demand contenders do not index alike: `kv-ondemand` has the compound docstore indexes `[projectId, status, updatedAt]`, `[assigneeId, status, updatedAt]` and `updatedAt`, and SQLite has TanStack's single-expression indexes on `status`, `projectId`, `assigneeId`, `updatedAt` and `id`. `status` is created first: SQLite has no statistics here, and between two indexes that each pin one field of a `where` its planner takes the one created last, so the todo column reads one project's issues and not every todo issue of the workspace. `kv-ondemand` creates no TanStack index, since docstore's indexes answer its screens. The other three contenders call TanStack's `createIndex` on those fields, which on SQLite also creates the SQL index. Neither has an index on labels. On SQLite the label screen loads every open issue of the project and takes its 50 in memory: the adapter sends no test of an array field to SQL, so the patch adds no `LIMIT`. The collections hold users, projects, labels and issues. No screen reads comments, so comment events are left out. A patch writes the changed fields of the row the collection holds. A batch's inserts, updates and deletes of one entity go in one `createTransaction`, which `utils.acceptMutations` persists in one commit. On demand, SQLite first holds the batch's rows with a live query on their ids, and docstore uses `utils.transact`, which reads them in its own transaction and also writes once per entity.

The phases:

1. `import` (timed): the history's import through the collections, 1,000 rows per transaction.
2. `settle` (untimed): kv flushes and compacts until stable.
3. `prepare` (fresh page, untimed): the history, the oracle, each screen's binding (curated on the state the import leaves, not on the whole history as in `tracker/goals`) and every expected answer.
4. `open` (timed): the collections open (op `open`; an eager collection loads every row), then the screens open one after another, as an app's would, each timed from creating its live query to its first answer (op named after the screen). Only the first screen starts cold: the later ones find the shared label list, the rows earlier joins loaded and kv's page cache warm, which matters for the on-demand contenders. Every answer is checked. `unopen` (untimed) closes the screens.
5. `sync` (timed): the first half of the sync batches, with no screen open.
6. `screens` (untimed): every screen opens again.
7. `sync-live` (timed): the second half, with every screen open. A batch is timed until it is persisted and every open screen shows it: no live query and no collection waits for rows, since a join loads the rows it lacks through its source collection. Answers are checked every 10 batches. `close` (untimed) closes the screens.
8. `reopen` (fresh page, untimed): the history and oracle again, then every screen opens from storage and its answer is compared with the one after the last batch, so a batch that was acknowledged but never stored fails the run.

`open`, `sync` and `sync-live` record the main thread, and the sync phases yield a macrotask between batches. The difference per batch between `sync` and `sync-live` is the screens' upkeep. The two halves are different batches of one history, alike in shape but not identical.

## Amplification

kv counts the bytes it writes in the configuration apps run: the tab and the SharedWorker host. The counters come from `readStats` in `@opfs-lsm/kv/testing`. The SharedWorker an app loads keeps none, so the bench page opens the one of `@opfs-lsm/kv/testing`, the same host with a meter. The report derives:

- **W-Amp engine**: (flush + compaction bytes written) / user bytes in. This is the number RocksDB and Pebble report.
- **W-Amp total**: (WAL + flush + compaction + manifest bytes) / user bytes in. It counts the WAL, as Lim et al. (FAST '16) do. WAL bytes are the records handed to IndexedDB; what IndexedDB itself writes is not visible.
- **Compaction**: compaction bytes / flush bytes.
- **Read-Amp**: L0 runs + non-empty deeper levels. After open, kv reads are in memory, so there is no per-read disk count.
- **Space-Amp**: OPFS bytes / live key and value bytes. Disk bytes add kv's IndexedDB WAL, from `navigator.storage.estimate()`, so they compare with the IndexedDB baselines.

kv counts WAL bytes per tab and file bytes per host. Once a second tab has written (`page: "other"`), the two have no common denominator, so a footprint after it reports the bytes on disk and Space-Amp but no W-Amp.

IndexedDB baselines only have `navigator.storage.estimate()`, which is approximate. Those cells are marked `~`. For the CRDT families, user bytes are the bytes the CRDT asked storage to save, and live bytes are the encoded document size.

The definitions and sources are in [docs/research/benchmark-prior-art.md](../docs/research/benchmark-prior-art.md).

## Byte budgets

`driver/budgets.ts` lists upper bounds on W-Amp total and Space-Amp for named rows: a workload, a contender, a size and a phase. Every `run` and `smoke` checks the rows it recorded, and one run over a bound fails it. `bench:smoke --check` also runs the rows above size `tiny` once, since compaction writes little at 1,000 entries.

Timings on a shared CI runner are too noisy to gate. Byte counters are not: over 21 runs of `kv/fillrandom` at size `small`, WAL bytes were identical and flush bytes stayed within 0.1%. Each budget sits a few percent above the value on the commit that set it. Only an upper bound is checked, so a row that can settle to more than one layout takes its budget from the layout that writes most. The tiny tracker is such a row: its history is flushed 3 or 4 times, as the flushes fall, and the fourth L0 run starts a compaction.

A budget whose row ran but recorded no such number fails too, so renaming a phase cannot switch a budget off. The budgets hold for kv's default options and seed 1: a run with `--cache-bytes`, `--compaction-memory-bytes` or another `--seed` is not checked, and the command says so. To raise a budget, say in the commit what made the engine write more.

## Memory

Every run record carries peaks sampled every 100 ms over CDP: `Runtime.getHeapUsage` of the workers and of each tab, the largest wasm `memory.buffer.byteLength` in each (a hook installed before the worker's or tab's wasm instantiates). A worker is the kv SharedWorker, found by the browser's auto-attach, or a dedicated worker, such as the one wa-sqlite runs in for the SQLite contenders, found by its tab's auto-attach; the peak is the largest of any worker of the run, and the largest renderer process. The report prints them per workload. On macOS the renderer value is `phys_footprint_peak`, the kernel's own peak since the process started, read before each tab closes and at the end of a run. Reading a process stalls it, and a later read returns the same peak, so the timed steps run unread. Elsewhere it is the largest RSS seen, read once a second. Chrome's `backingStorageSize` counts ArrayBuffers but not wasm memory, so a worker's total is used + backing + wasm, the largest that one worker held in one sample (`mem:workerTotal`). The peaks of the three parts can come from different workers and moments, so they do not add up to it. `--max-peak-bytes N` fails a run whose worker total passes N; it is off by default. The total includes objects and ArrayBuffers that are already garbage and that V8 has not collected yet, so it can sit far above what is alive (see below). `--compaction-memory-bytes N` passes N to every kv `openDb` as `compactionMemoryBytes`; it is unset by default, which leaves the 32 MiB default, and it takes at least 8388608, since kv raises a smaller figure to 8 MiB. `--cache-bytes N` passes N as `cacheBytes`, the bytes of run files a tab keeps in memory. The default is 256 MiB, above the data of every size here, so a default run never evicts a page: `pnpm bench kv/fillrandom --cache-bytes 4194304` reads 11.6 MB through a 4 MiB cache. `--cache-bytes` takes at least 1048576, since kv raises a smaller cache to 1 MiB. A run of a contender whose store is kv records either flag, and the report prints it under the host line. The other contenders ignore both flags. The host's own counters (`wasmBytes`, `wasmPeakBytes`, `mergeReservedBytes`, `recycles`) are in each record's `footprint.kv.host.memory`.

`node bench/probes/memory.ts` answers two Chrome questions behind the compaction-memory design: whether pending `createWritable` data stays in memory, and whether dropping a wasm instance returns its memory. Results are in [docs/research/bounded-compaction-memory.md](../docs/research/bounded-compaction-memory.md).

`node bench/probes/live-set.ts [workload] [--compaction-memory-bytes N]` measures what is alive in the SharedWorker while a workload runs. A second DevTools session takes a heap snapshot every 500 ms (V8 collects garbage before it writes one) and the probe prints the wasm memory and everything else per snapshot. Each snapshot pauses the worker, so the run's timings mean nothing.

`node bench/probes/idb-deleted-tail.ts [rows] [kept] [rounds]` builds the states kv's IndexedDB WAL store is in and times ten ways to find its head, over fresh tabs. A flush deletes the records the previous flush folded and keeps its own. In Chrome 157, right after a flush that deleted 24,700 records, every range read past the last record takes 2 to 3 ms, and an unbounded reverse cursor about 25 ms, while a point read of `ingestedThrough + 1` takes 0.07 ms. That is why kv reads that key first. With records above `ingestedThrough`, the reverse cursor that finds the last one takes 0.1 to 16 ms, depending on whether IndexedDB has compacted the deleted rows yet. A tab that is caught up reads the key past its own `appliedThrough` and skips that cursor.

`node bench/probes/cpu-profile.ts <workload> <phase> [--contender kv/kv]` records a V8 CPU profile of one phase, in the tab and in the SharedWorker, and prints self time per function. The build is not minified, so the names are the source's. It writes each `.cpuprofile` to `bench/results/` for DevTools. Profiling slows the run, so compare the shares between functions, not the wall time.

`node bench/probes/open-paired.ts --a <packages/kv> [--b <packages/kv>]` compares the cold `openDb` of two builds of kv, one database of 100,000 entries per build: each round opens each once in a fresh tab, and the probe prints the median per build and the median difference per round. With one build it shows how far two runs of that build differ. It then prints one open as a timeline of its browser calls: locks, OPFS, IndexedDB and wasm.

## Main thread

kv answers reads on the tab's main thread, while IndexedDB works in the browser process, so latency alone hides what kv costs a frame. A phase with `mainThread: true` records the tab's main thread while it runs:

- **Long tasks**, from the `longtask` observer: their count, the longest, and blocked ms. Blocked ms sums each task's time past 50 ms, the Total Blocking Time rule.
- **Frames**, from `requestAnimationFrame`: their count, frame ms, the longest frame, and dropped frames. Frame ms is the display's interval: the smallest step of the vsync timestamps Chrome passes to the callbacks, over a few idle frames before the phase and the frames of the phase. A median over the phase would read 33.3 ms when most frames are late, and hide the drops. Dropped frames sums `round(gap / frame ms) - 1` over the gaps.

The long task observer cannot see a block of 17 to 50 ms, which still drops frames. So 0 long tasks means nothing without 0 dropped frames next to it. A gap is the time between two callbacks running (`performance.now()`), not between their timestamps, which stay at 16.7 ms steps through a block under about 40 ms.

Only phases that model a user interaction opt in, and they yield a macrotask between interactions. A loop of thousands of awaited calls with no yield is one giant task, which says nothing about a user.

`node bench/probes/main-thread.ts` checks the collector in headless Chrome. It passes when 300 ms of idle drops no frame at a 8 to 34 ms frame interval, when a planted 30 ms block drops one or two frames with a longest frame of 30 to 70 ms and no long task, and when a planted 200 ms busy loop gives exactly one long task of 200 to 260 ms and 150 to 210 ms blocked.

## Bundle size

`pnpm bench:size` measures what Vite emits for each row in `size/rows.ts`: the import an app writes. The rows are built apart from the bench page, so a chunk holds nothing the page imports for its own use. "At import" is the entry chunk and its static imports. "After open" adds every file those load later: the SharedWorker chunk, its imports and the `.wasm`. Each file is compressed on its own (gzip -9, brotli 11). `--check` fails when a row is over a budget, and CI runs it. A row can have two: brotli bytes after open, and gzip bytes at import, which is what the row adds to an app's main bundle. The build also fails if any module is inlined as a `data:` URL, which is how Vite broke kv's SharedWorker before its URL was written inline in the constructor.

## Adding a workload or contender

A workload is one file in `workloads/<family>/`. A contender is one file in `contenders/<family>/`. Every workload runs on every contender of its family. The page finds both with `import.meta.glob`, so nothing else lists them. Each family's interface is in `core/families.ts`. A workload calls only that interface, so every contender does the same operations.

A workload names the access patterns it owns in `owns`, from the list in `core/patterns.ts`. Each pattern has exactly one owner, and `bench:smoke --check` fails when one has none or two. A goal workload owns its dataset's patterns and one per goal. Before adding a workload, find the pattern's owner: a new phase there is usually the smaller change.

A workload is a list of phases run in order on one database (`page: "fresh"` starts a new tab, and `rounds: n` on it runs the phase in `n` tabs of its own and records the later rounds under the first; `ctx.round` says which). `page: "other"` runs the phase in the tab that did not run the one before: the second tab opens on first use, and the first tab stays open with its store. There are at most two tabs, and the probes refuse a workload with an `"other"` phase. A phase body only does the ops. A timed read phase starts from one cache state: put `warmPhase()` before it for warm pages, or run it on a fresh page for cold ones. A read phase right after a settle is warm in some runs and cold in others. A phase's ops/s is its ops over its span: from the start of its first `ctx.time` call to the end of its last, the store open left out, since it has its own op (`spanMs` in the record). The gaps between calls count, so a store that keeps working in the background while the harness builds the next call is not credited for that work. A phase body therefore builds its inputs before the first call, checks results after the last, and puts persistence work inside `ctx.time`; harness work that cannot move out of the gaps costs every contender the same time. `ctx.time` times one call, `ctx.model` holds the expected values, `ctx.rng` is seeded from the run's seed, the workload, the phase, the round and the rep, the same for every contender. A workload's `params` carries no seed: the page adds the run's, so `ctx.params.seed` is the one to derive any other seeded data from.

A goal is one entry in its dataset's spec type (`datasets/tracker/types.ts`), whose doc comment is the answer spec. After that, `tsc` fails until the oracle, the goal's curation (`datasets/tracker/index.ts`) and every contender answer it, and its phase appears by itself. A second dataset is a `datasets/<name>/` directory with the same files, a family in `core/families.ts`, its contenders and a one-line workload that calls `goalWorkload`.

## Layout

```
cli.ts            run | smoke | size | compare | report | docs
docs-tables.ts    the results tables of docs/benchmarks.md: the run and the series of each cell
core/             types, family interfaces, the goal contract, access patterns, histogram
datasets/         one directory per goal dataset: types and goal spec, history, oracle, curation
driver/           Vite build, static server, Chrome over CDP, plan, run loop, metrics, report, size
page/             the bench page: phase executor, data model, kv and IndexedDB helpers
size/rows.ts      bundle-size rows and budgets
contenders/       one file per contender, by family
workloads/        one file per workload, by family; kv-lib.ts, trace.ts and goals-lib.ts are shared helpers
```
