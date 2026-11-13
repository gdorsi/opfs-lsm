---
layout: home
title: opfs-lsm
hero:
  name: opfs-lsm
  text: Fast local storage for your web app
  tagline: without bloating it
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/#quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
adapters:
  command: pnpm bench
  frameworks:
    - name: TanStack DB
      baseline: its IndexedDB adapter, both in eager mode
      rows:
        - workload: Cold load, 91,000 rows
          indexeddb: 112k rows/s
          kv: 176k rows/s
          ratio: 1.6×
        - workload: Bulk insert
          indexeddb: 17.2k rows/s
          kv: 115k rows/s
          ratio: 6.7×
    - name: TanStack DB on-demand
      baseline: its SQLite adapter, both in on-demand mode
      versus: SQLite
      rows:
        - workload: 10 rows by id
          indexeddb: 1.9k queries/s
          kv: 4.1k queries/s
          ratio: 2.1×
        - workload: Warm query, 6,250 rows
          indexeddb: 116k rows/s
          kv: 169k rows/s
          ratio: 1.5×
    - name: Yjs
      baseline: y-indexeddb
      rows:
        - workload: Cold load, 500 notes
          indexeddb: 2.0k notes/s
          kv: 9.5k notes/s
          ratio: 4.8×
        - workload: Editing trace
          indexeddb: 1.4k edits/s
          kv: 33.2k edits/s
          ratio: 23×
    - name: Automerge
      baseline: automerge-repo IndexedDB
      rows:
        - workload: Cold load, 500 notes
          indexeddb: 1.1k notes/s
          kv: 2.2k notes/s
          ratio: 2.0×
        - workload: Write 500 notes
          indexeddb: 743 notes/s
          kv: 821 notes/s
          ratio: 1.1×
    - name: fate
      baseline: its IndexedDB persistence
      rows:
        - workload: Cold load, 100 lists
          indexeddb: 1.0k records/s
          kv: 3.4k records/s
          ratio: 3.3×
        - workload: Queue 300 mutations
          indexeddb: 201 ops/s
          kv: 263 ops/s
          ratio: 1.3×
size:
  main: 18.8 kB
read:
  framework: TanStack DB
  workload: On-demand, 10 rows by id
  baseline: SQLite
  other: 1.9k queries/s
  kv: 4.1k queries/s
  ratio: 2.1×
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
---

<div class="home-features">
<div>

### Lightweight, with super-fast loads

18.8 kB at import, and cold loads up to 4.8× faster than IndexedDB

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
const rows = db.range({ limit: 50 });
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
  const comments = snap.range(ofIssue);
});
```

</div>
</div>

[TanStack DB](../packages/tanstack-db/README.md) · [fate](../packages/fate/README.md) · [Yjs](../packages/yjs/README.md) · [Automerge](../packages/automerge/README.md) · [docstore](../packages/docstore/README.md) · [kv API](../packages/kv/README.md)

## Use cases

opfs-lsm is a replacement for IndexedDB and SQLite in the browser. It is faster, lightweight and designed specifically for web apps.

<Illustration name="fits" full :data="{ cases: $frontmatter.fits }" label="Where opfs-lsm fits, in four cases. In each, a server syncs with a library in the browser, and that library stores its data in opfs-lsm. Offline-first apps: TanStack DB collections store every row with @opfs-lsm/tanstack-db. A cache of server data: the fate client stores cached records and queued mutations with @opfs-lsm/fate. Collaborative documents: Y.Doc or automerge-repo store document updates with @opfs-lsm/yjs or @opfs-lsm/automerge. Your own sync engine: it stores keys and bytes with @opfs-lsm/kv." />

## Try it with 100,000 issues

[LinearLite on docstore](../examples/linearlite-docstore), with no server

<HomeDemo />

## Optimized for fast loads, great at batched writes

[The adapter benchmarks](../README.md#benchmarks) · [How they are measured](../bench/README.md)

<Illustration name="adapters" full :data="$frontmatter.adapters" label="The adapter benchmarks, each opfs-lsm adapter against the IndexedDB option of its framework. TanStack DB, both collections in eager mode: cold load of 91,000 rows 176k rows/s against 112k, 1.6× faster; bulk insert 115k rows/s against 17.2k, 6.7× faster. TanStack DB against its SQLite adapter, both in on-demand mode: 10 rows by id 4.1k queries/s against 1.9k, 2.1× faster; a warm query of 6,250 rows 169k rows/s against 116k, 1.5× faster. Yjs against y-indexeddb: cold load of 500 notes 9.5k notes/s against 2.0k, 4.8× faster; editing trace 33.2k edits/s against 1.4k, 23× faster. Automerge against automerge-repo's IndexedDB storage: cold load of 500 notes 2.2k notes/s against 1.1k, 2.0× faster; writing 500 notes 821 notes/s against 743, 1.1× faster. fate against its IndexedDB persistence: cold load of 100 lists 3.4k records/s against 1.0k, 3.3× faster; queueing 300 mutations 263 ops/s against 201, 1.3× faster." />

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../README.md#browser-support)

</div>
<Illustration name="stack" />
</div>
