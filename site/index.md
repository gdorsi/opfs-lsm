---
layout: home
title: opfs-lsm
intro:
  title: Fast local storage for your web app
  tagline: This issue tracker keeps 100,000 issues in your browser. There is no server.
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
apps:
  command: pnpm bench linearlite/ yjs/whiteboard-session pages/
  frameworks:
    - name: LinearLite
      baseline: TanStack's SQLite adapter, patched to send LIMIT to SQLite, 100,000 issues
      versus: SQLite
      rows:
        - workload: First rows, once the database is open
          indexeddb: 52.2 ms
          kv: 44.1 ms
          ratio: 1.2×
        - workload: Change the sort
          indexeddb: 11.5 ms
          kv: 5.76 ms
          ratio: 2.0×
        - workload: Open the board
          indexeddb: 135 ms
          kv: 24.1 ms
          ratio: 5.6×
    - name: Whiteboard
      baseline: y-indexeddb, 1,000 shapes
      rows:
        - workload: 1,000 edits, until saved
          indexeddb: 109 ms
          kv: 41.0 ms
          ratio: 2.7×
        - workload: 100 undos and redos, until saved
          indexeddb: 21.5 ms
          kv: 7.8 ms
          ratio: 2.8×
        - workload: Reopen the board
          indexeddb: 75.0 ms
          kv: 87.0 ms
          ratio: 0.86×
    - name: Notes
      baseline: Automerge on IndexedDB, a 50 KB page, on an Apple M2 Pro
      rows:
        - workload: Open a new page
          indexeddb: 2.88 ms
          kv: 2.75 ms
          ratio: 1.0×
        - workload: Reopen after a reload
          indexeddb: 143 ms
          kv: 145 ms
          ratio: 0.99×
size:
  main: 18.8 kB
fits:
  - name: TanStack DB
    package: "@opfs-lsm/tanstack-db"
    case: Offline-first apps
    detail: The whole dataset lives in the browser, and the UI queries it there
    library: TanStack DB collections
    stores: every row
  - name: fate
    package: "@opfs-lsm/fate"
    case: A cache of server data
    detail: What the app has fetched, plus the mutations made while offline
    library: fate client
    stores: cached records and queued mutations
  - name: Yjs or Automerge
    package: "@opfs-lsm/yjs, @opfs-lsm/automerge"
    case: Collaborative documents
    detail: Persist your CRDT locally, so it is available offline and loads faster
    library: Y.Doc or automerge-repo
    stores: document updates
  - name: Your own
    package: "@opfs-lsm/kv"
    case: Your own sync engine
    detail: kv is a faster alternative to IndexedDB with a better API, to make your sync engine load faster
    library: your sync engine
    stores: your keys and bytes
demo:
  count: 100,000
  source: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-docstore
---

<div class="home-warnings">

::: warning
opfs-lsm is still under heavy development.

We want it to be the building block for the best UX in web apps, and still ironing the fundamental details.

Still, storage is fault-tolerant and heavily tested, so if you want to play around, feedback is very welcome!
:::

</div>

<div class="home-features">
<div>

### Lightweight, with super-fast loads

18.8 kB at import, and up to 4.8× faster cold loads with the Yjs adapter

```ts
// 18.8 kB gzip in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker and wasm load here
const db = await openDb({ name: "app" });
```

</div>
<div>

### Use it with your framework

Adapters for TanStack DB, Yjs, Automerge and fate

```ts
const todos = createCollection(
  docstoreCollectionOptions({
    collection: store.collection("todos"),
  }),
);
```

</div>
<div>

### A low-level API for your own adapter

A key-value storage you can use to build your own DB

```ts
await db.put(key, bytes);
const saved = await db.get(key);
for await (const { value } of db.range({ limit: 50 })) {
  // ...
}
```

</div>
<div>

### Quota management

Your app picks what to drop before the browser refuses writes

```ts
const db = await openDb({
  name: "app",
  maxBytes: "quota",
});
db.onPressure(({ need }) => evict(need));
```

</div>
<div>

### Live subscriptions

Every write, from any tab, in order

```ts
db.changes((event) => {
  if (event.kind !== "append") return;
  render(event.seq, event.ops);
});
```

</div>
<div>

### Snapshot reads

Reads that later writes cannot change

```ts
await db.view(async (snap) => {
  const issue = await snap.get(issueKey);
  for await (const { key, value } of snap.range(ofIssue)) {
    render(key, value);
  }
});
```

</div>
</div>

[TanStack DB](../packages/tanstack-db/README.md) · [fate](../packages/fate/README.md) · [Yjs](../packages/yjs/README.md) · [Automerge](../packages/automerge/README.md) · [docstore](../packages/docstore/README.md) · [kv API](../packages/kv/README.md)

## Use cases

opfs-lsm is a replacement for IndexedDB and SQLite in the browser. It is faster, lightweight and designed specifically for web apps.

<Illustration name="fits" full :data="{ cases: $frontmatter.fits }" label="Where opfs-lsm fits, in four cases. In each, a server syncs with a library in the browser, and that library stores its data in opfs-lsm. Offline-first apps: TanStack DB collections store every row with @opfs-lsm/tanstack-db. A cache of server data: the fate client stores cached records and queued mutations with @opfs-lsm/fate. Collaborative documents: Y.Doc or automerge-repo store document updates with @opfs-lsm/yjs or @opfs-lsm/automerge. Your own sync engine: it stores keys and bytes with @opfs-lsm/kv." />

## Measured on real apps

[The app benchmarks](../docs/benchmarks.md#app-benchmarks) · [How they are measured](../bench/README.md)

<Illustration name="apps" full :data="$frontmatter.apps" label="The app benchmarks, each example app on opfs-lsm against the same app on the storage it would otherwise use. LinearLite with 100,000 issues, docstore against TanStack DB's SQLite adapter, patched to send LIMIT to SQLite: once the database is open, the first rows of a cold open in 44.1 ms against 52.2 ms, 1.2× faster; a change of sort in 5.76 ms against 11.5 ms, 2.0× faster; the board in 24.1 ms against 135 ms, 5.6× faster. A Yjs whiteboard with 1,000 shapes, against y-indexeddb: 1,000 edits saved in 41.0 ms against 109 ms, 2.7× faster; 100 undos and redos saved in 7.8 ms against 21.5 ms, 2.8× faster; reopening the board takes 87.0 ms against 75.0 ms, 0.86× as fast. A notes app on Automerge with a 50 KB page, against IndexedDB, on an Apple M2 Pro: opening a new page takes 2.75 ms against 2.88 ms, 1.0× as fast; reopening it after a reload 145 ms against 143 ms, 0.99× as fast." />

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

</div>
<Illustration name="stack" />
</div>
