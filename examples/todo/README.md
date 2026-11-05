# Todo list example

Two browser windows share one todo list. Each window calls `openCollectionDb` on the same database name, with one `todos` table. A SharedWorker ingests the write-ahead log into OPFS. After ingest, both windows list the same todos.

The page can also seed a large random dataset, filter it, sort it, and page through it. Pages are cursor scans over a collections index, not full loads: secondary indexes cover the sort orders, and each page reaches into the LSM instead of reading every row.

## Run the example

1. From the repo root, build the kv and collections packages and start the page.

   ```sh
   pnpm todo:example
   ```

   The command prints `http://127.0.0.1:4173/examples/todo/index.html` and opens it. The page shows `db todos, page 1, 0 items` and `No todos yet.` SharedWorker and OPFS need that http origin. A `file://` page cannot open the database.

2. Open a second window.

   Click **Open second window**, or open the same URL again.

3. Add a todo in one window.

   Press Enter in **New todo**, or click **Add**. The row appears at the top of page 1 in both windows after the write is acknowledged.

4. Seed data, filter, sort, and page.

   Type a count in **Generate random todos** and click **Generate**. Titles are 2 to 5 random words. Generation writes 1,000 rows per batch and reports progress. **Filter todos** narrows the list by a case-insensitive substring and resets to page 1. The sort selector switches between **Newest first**, **Oldest first**, and **Title A–Z**; the filter stays applied. **Prev**/**Next** move through the cursor stack; returning to an earlier page does not rescan from the start of the database. **Clear all** deletes the seeded rows in batches.

5. Click **Ingest** in either window.

   Both lists still show the rows. The next read uses the new OPFS generation. The window that clicked **Ingest** shows `generation N` under the status line.

To start from an empty database, open `http://127.0.0.1:4173/examples/todo/index.html?name=fresh`. The name must match `[A-Za-z0-9_-]{1,64}`.

Set `TODO_PORT` to change the port. Set `TODO_NO_OPEN=1` to skip opening a browser.

You can also serve the repo root with any static file server after `pnpm --filter @opfs-lsm/kv build && pnpm --filter @opfs-lsm/collections build`, then open `/examples/todo/index.html`.

## Modules

`main.js` is the DOM layer: open the database, wire buttons, render rows. It imports `openCollectionDb` from `@opfs-lsm/collections`; the import map in `index.html` points both `@opfs-lsm/kv` and `@opfs-lsm/collections` at their built files. `CollectionDb` wraps the kv database, so the page subscribes to `db.kv.changes`, calls `db.ingest`, and passes `db.table("todos")` into the model.

`worker.js` imports `packages/kv/dist/host/shared-worker.js`. That file is the `@opfs-lsm/kv/shared-worker` export. A module worker does not use the page import map, so the worker names the built file directly. `openCollectionDb` forwards `worker.js` as `workerUrl`.

`model.mjs` is headless: no DOM access and no package import. It owns the table schema, derived sort fields, title generation, filter matching, paging, and bulk operations. Its only contract is a collections `Table` shape: `put`, `putMany`, `update`, `delete`, `clear`, and `page`. The page passes the real table; the tests pass a plain in-memory fake.

The table is `todos`, primary key `id`. Collections stores a row at `t/` plus table and id, and an index entry at `i/` plus table, index, typed value, and id. Three declared indexes cover the sorts: `byNewest` on `newest` (`10^15 - 1 - createdAt`), `byOldest` on `createdAt`, and `byTitle` on `titleSort` (the lowercased title). Strings in index keys are encoded lexicographically, so `byTitle` is A–Z; the trailing id breaks ties.

`Table.put`, `putMany`, `delete`, and `clear` maintain the index entries in the same transaction as the primary row, so a row and its indexes cannot drift. `Table.update` compares index keys and rewrites only the ones that changed, so toggling `done` touches the primary value alone.

`readPage` picks the index for the requested sort and calls `table.page(index, { after, limit })`. A chunk is at most one page, so filling a page always lands on a chunk boundary, even with a filter. `next` is the first index key the call did not consume, so pages neither skip nor repeat rows. A filter that matches nothing scans the whole index; a filter that matches early stops early.

`generateTodos` chunks `table.putMany` at 1,000 rows. `clearTodos` calls `table.clear`, which removes primary and index rows in batches under the kv limits (10,000 ops and 8 MiB).

## Check the model

```sh
node --test examples/todo/model.test.mjs
```

The command exits 0. It does not open a browser. It covers the derived sort fields, filter matching, cursor paging across chunks, all three sort orders, generation, clear, and toggle. The table is an in-memory fake, so no build is needed. The same model can drive a headless benchmark by passing a real `Table` from `openCollectionDb`.
