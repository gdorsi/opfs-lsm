# whiteboard-yjs

A Yjs whiteboard on `@opfs-lsm/kv`, with `y-indexeddb` as the second storage. The browser app and the bench drive the same model.

```sh
pnpm --filter @opfs-lsm/example-whiteboard-yjs dev   # http://localhost:4183
```

Query parameters: `?storage=idb` uses `y-indexeddb` instead of kv, `?db=name` picks the database (default `whiteboard`), `?fault=1` exposes `whiteboardFault` so a storage error can be injected. In dev, the board list offers sample boards of 5,000 and 20,000 shapes.
