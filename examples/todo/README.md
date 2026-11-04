# Todo list example

Two browser windows share one todo list. Each window calls `openDb` on the same database name. A SharedWorker ingests the write-ahead log into OPFS. After ingest, both windows list the same todos.

## Run the example

1. From the repo root, build the kv package and start the page.

   ```sh
   pnpm todo:example
   ```

   The command prints `http://127.0.0.1:4173/examples/todo/index.html` and opens it. The page shows `db todos, 0 items` and `No todos yet.` SharedWorker and OPFS need that http origin. A `file://` page cannot open the database.

2. Open a second window.

   Click **Open second window**, or open the same URL again.

3. Add a todo in one window.

   Press Enter in **New todo**, or click **Add**. The other window lists that row after the write is acknowledged.

4. Click **Ingest** in either window.

   Both lists still show the row. The next read uses the new OPFS generation. The window that clicked **Ingest** shows `generation N` under the status line.

To start from an empty database, open `http://127.0.0.1:4173/examples/todo/index.html?name=fresh`. The name must match `[A-Za-z0-9_-]{1,64}`.

Set `TODO_PORT` to change the port. Set `TODO_NO_OPEN=1` to skip opening a browser.

You can also serve the repo root with any static file server after `pnpm --filter @opfs-lsm/kv build`, then open `/examples/todo/index.html`.

## Modules

`main.js` imports `openDb` and `prefixBound` from `@opfs-lsm/kv`. The import map in `index.html` points that name at `packages/kv/dist/index.js`.

`worker.js` imports `packages/kv/dist/host/shared-worker.js`. That file is the `@opfs-lsm/kv/shared-worker` export. A module worker does not use the page import map, so the worker names the built file directly. `openDb` receives `worker.js` as `workerUrl`.

`model.mjs` encodes each todo. The key is `todo/` plus an id. The value is JSON with `title`, `done`, and `createdAt`. The list on screen is a `range` over that prefix, sorted by `createdAt`.

## Check the row codec

```sh
node --test examples/todo/model.test.mjs
```

The command exits 0. It does not open a browser.
