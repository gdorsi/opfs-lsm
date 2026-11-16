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

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

</div>
<Illustration name="stack" />
</div>
