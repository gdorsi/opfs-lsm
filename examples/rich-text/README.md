# Rich text editor + KV persistence

Minimal React + [Tiptap](https://tiptap.dev/) example that persists a rich-text document using a small persistence layer built on `@opfs-lsm/kv`.

## Persistence layer

[`src/kv-document-store.ts`](./src/kv-document-store.ts) is the whole storage layer:

- Opens the database with `openDb({ name })`: OPFS, with a per-tab log the SharedWorker ingests.
- Stores one document per `docId` as UTF-8 JSON under the key `doc:<docId>`.
- `load()` → `db.get(key)` → parse JSON.
- `save(doc)` → UTF-8 bytes of `JSON.stringify(doc)`, then `db.put` (one record in this tab's log).
- `onChange()` → `db.changes(...)` so another tab’s save, once ingested, can trigger `sync()` + reload.

The editor (`App.tsx`) debounces saves, flushes a pending save on unload and unmount, and will not apply a remote reload over an edit that has not been written yet.

## Run

From the repo root:

```sh
pnpm install
pnpm rich-text:example
```

Open the same URL in a second window to see cross-tab updates. Use `?name=<db>&doc=<id>` to pick a database/document.
