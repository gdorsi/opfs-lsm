# Todo list example (React on TanStack Redact)

Two browser windows share one todo list. Each window opens kv with `openDb` on the same database name and `openDocStore` on top of it, with one `todos` collection. A SharedWorker ingests the write-ahead log into OPFS. Both windows subscribe to `kv.changes`, so a write in one window refreshes the other.

The UI is a React app in TypeScript. Vite builds it with the TanStack Redact plugin, which aliases `react` and `react-dom` to Redact's smaller synchronous runtime at build time — the imports in `main.tsx` stay ordinary React. The app is client-only and uses no optional features (no portals, context, Suspense, or hydration), so the plugin runs the `nano` preset.

The page can also seed a large random dataset, filter it, sort it, and page through it. Pages are cursor scans over a docstore index, not full loads: declared indexes cover the sort orders, and each page reaches into the LSM instead of reading every row.

## Run the example

1. From the repo root, build the kv and docstore packages and start the dev server.

   ```sh
   pnpm todo:example
   ```

   The script builds both packages, then opens `http://127.0.0.1:4173/`. The page shows `db todos, page 1, 0 items` and `No todos yet.` SharedWorker and OPFS need that http origin. A `file://` page cannot open the database. If 4173 is taken, Vite moves to the next port.

   To run against a production bundle instead, use `pnpm todo:example:build` (typecheck, build, then serve `dist/` on 4173). `tsc -p tsconfig.json` runs before `vite build`, and the build output prints the client JS + CSS sizes for the Redact runtime.

2. Open a second window.

   Click **Open second window**, or open the same URL again.

3. Add a todo in one window.

   Press Enter in **New todo**, or click **Add**. The row appears at the top of page 1 in both windows after the write is acknowledged.

4. Seed data, filter, sort, and page.

   Type a count in **Generate random todos** and click **Generate**. Titles are 2 to 5 random words. Generation writes 1,000 rows per batch and reports progress. **Filter todos** narrows the list to todos where each typed word occurs inside a word of the title, ignoring case, so "mil" and "lk" both find "Buy milk". It resets to page 1, and search results are newest first. The sort selector switches between **Newest first**, **Oldest first**, and **Title A–Z** when no filter is set. **Prev**/**Next** move through the cursor stack; returning to an earlier page does not rescan from the start of the database. **Clear all** deletes the seeded rows in batches.

5. Click **Ingest** in either window.

   Both lists still show the rows. The next read uses the new OPFS generation. The window that clicked **Ingest** shows `generation N` under the status line.

To start from an empty database, open `http://127.0.0.1:4173/?name=fresh`. The name must match `[A-Za-z0-9_-]{1,64}`.

Set `TODO_PORT` to change the port. Set `TODO_NO_OPEN=1` to skip opening a browser.

## Modules

`store.ts` is the page store: it opens kv and the docstore once at module level (top-level await, like the DOM version did), declares the schema, subscribes to `kv.changes`, serializes writes through one promise chain, owns the pager cursor stack, and exposes actions. React reads it with `useSyncExternalStore(store.subscribe, store.getSnapshot)` — components hold no effects and no async state. The snapshot shape (`rows`, `hasNext`, `pageIndex`, `filter`, `sort`, `progress`, `error`, `generation`, `bulkBusy`) mirrors what the DOM version wrote straight into elements. `index.html` keeps a static `opening` line inside `#root`, painted while the module opens and loads the first page.

`main.tsx` is the React layer: render the snapshot, dispatch actions, and own the two uncontrolled inputs plus the filter-input debounce (a typing concern, not store state). Vite resolves both `@opfs-lsm/kv` and `@opfs-lsm/docstore` from the workspace packages, so `index.html` needs no import map. Writes, deletes, and bulk jobs still go through the headless model. `tsconfig.json` typechecks the sources with `strict: true`; the collection is assigned to `TodoStore`, so a query the schema does not declare fails to compile.

`vite.config.mjs` mounts `@vitejs/plugin-react` and `redact()` with `preset: "nano"`. `optimizeDeps.exclude` keeps the two workspace packages unlocked so the engine's runtime `new URL(..., import.meta.url)` still points at the committed `wasm/` files in dev. `TODO_REDACT=0` skips the plugin and builds plain React, for a bundle-size comparison. `worker: { format: "es" }` keeps the SharedWorker that `@opfs-lsm/kv` spawns itself a module worker (it uses dynamic `import()` for the wasm glue).

`model.ts` is headless: no DOM access and no runtime package import (the docstore types are type-only imports, erased at build time). It owns the derived `titleSort` field, title generation, filter matching, paging, and bulk operations. Its only contract is `TodoStore`: `put`, `putMany`, `modify`, `delete`, `clear`, and `query`, the slice of a docstore `Collection<Todo>` it uses. The page passes a real collection; the tests pass a plain in-memory fake whose cursors are row ids.

The collection is `todos`, keyed by `id`. `store.ts` declares three indexes with `defineSchema`: `byCreated` on `createdAt`, `byTitle` on `titleSort` (the lowercased title), and `search`, a text index on `createdAt` that also carries the lowercased words of `title`. docstore stores a row under `0x64`, the collection id, `0x00` and the id, and an index entry under `0x64`, the collection id, the index id, the encoded values and the id. Newest first is `byCreated` read with `reverse: true`, so it needs no derived column. Strings in index keys order by their UTF-8 bytes, so `byTitle` is A–Z because `titleSort` is lowercased; the trailing id breaks ties. A todo costs four keys: the row and one entry in each index.

`put`, `putMany`, `delete`, and `clear` keep the index entries in step with the rows, so a row and its indexes cannot drift. `put` and `putMany` do it in one kv transaction. `modify` diffs the index entries of the old and new document and writes only the ones that changed, so toggling `done` rewrites the row alone.

`readPage` calls `collection.query({ index, reverse, after, limit })` for the requested sort. `limit` is the page size. `next` is the last entry of the page, and the following call passes it as `after`, so pages neither skip nor repeat rows. With a filter, `readPage` queries `search` with `match: filter` and `reverse: true`: one cursor page of todos where each filter word occurs inside a title word, newest first. A common word fills a page after a few entries; a filter that matches nothing reads every search entry.

`generateTodos` chunks `collection.putMany` at 1,000 rows. `clearTodos` calls `collection.clear`, which is one catalog write whatever the size; docstore deletes the old keys in the background. `clear` returns no count, so the status line reads `cleared all todos`.

## Check the model

```sh
pnpm --filter @opfs-lsm/example-todo test
```

Runs `tsx --test model.test.ts`. The command exits 0. It does not open a browser. It covers the derived title sort field, filter matching, cursor paging, all three sort orders, generation, clear, and toggle. The table is an in-memory fake, so no build is needed. The same model can drive a headless benchmark by passing a real `Collection` from `openDocStore`.
