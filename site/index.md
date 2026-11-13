---
layout: home
title: opfs-lsm
hero:
  name: opfs-lsm
  text: A faster database for the browser
  tagline: A k/v store you can use to speed up your sync engine, without having to bloat your app
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
      baseline: its IndexedDB adapter
      rows:
        - workload: Cold load, 91,000 rows
          indexeddb: 112k rows/s
          kv: 176k rows/s
          ratio: 1.6×
        - workload: Bulk insert
          indexeddb: 17.2k rows/s
          kv: 115k rows/s
          ratio: 6.7×
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
  main: 17.2 kB
  worker: 11.5 kB
  wasm: 16.3 kB
  lazy: 27.9 kB
demo:
  count: 100,000
---

<div class="home-features">
<div>

### Use it with your framework

Adapters for TanStack DB, Yjs, Automerge and fate

```ts
const todos = createCollection(
  docstoreCollectionOptions({
    collection: docs.collection("todos"),
  }),
);
```

</div>
<div>

### A low-level API for your own adapter

Bytes in, bytes out, with batches and ordered scans

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
<div>

### Lightweight, with super-fast loads

17.2 kB at import, and cold loads up to 4.8× faster than IndexedDB

```ts
// 17.2 kB gzip in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker and wasm load here
const db = await openDb({ name: "app" });
```

</div>
</div>

[The full API](../packages/kv/README.md)

## Try it with 100,000 issues

[LinearLite on docstore](../examples/linearlite-docstore), with no server

<HomeDemo />

## Optimized for fast loads, great at batched writes

[The adapter benchmarks](../README.md#benchmarks) · [How they are measured](../bench/README.md)

<Illustration name="adapters" full :data="$frontmatter.adapters" label="The adapter benchmarks, each opfs-lsm adapter against the IndexedDB option of its framework. TanStack DB: cold load of 91,000 rows 176k rows/s against 112k, 1.6× faster; bulk insert 115k rows/s against 17.2k, 6.7× faster. Yjs against y-indexeddb: cold load of 500 notes 9.5k notes/s against 2.0k, 4.8× faster; editing trace 33.2k edits/s against 1.4k, 23× faster. Automerge against automerge-repo's IndexedDB storage: cold load of 500 notes 2.2k notes/s against 1.1k, 2.0× faster; writing 500 notes 821 notes/s against 743, 1.1× faster. fate against its IndexedDB persistence: cold load of 100 lists 3.4k records/s against 1.0k, 3.3× faster; queueing 300 mutations 263 ops/s against 201, 1.3× faster." />

<div class="home-claim flip">
<div class="home-copy">

## Lightweight

17.2 kB are part of the critical path to load, and the rest is loaded lazily · [File by file](../README.md#bundle-size)

</div>
<Illustration name="bundle" :data="$frontmatter.size" label="A page imports kv and downloads 17.2 kB. When a click handler calls openDb, the SharedWorker chunk (11.5 kB) and the wasm engine (16.3 kB) load, 27.9 kB more." />
</div>

## Packages

<div class="home-adapters">

- [TanStack DB](../packages/tanstack-db/README.md) Collections
- [Yjs](../packages/yjs/README.md) Documents
- [Automerge](../packages/automerge/README.md) Repo storage
- [fate](../packages/fate/README.md) Client persistence
- [docstore](../packages/docstore/README.md) JSON documents, in beta
- [kv API](../packages/kv/README.md) Your own layer

</div>

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../README.md#browser-support)

</div>
<Illustration name="stack" label="A tab puts a record, which becomes a row of the write-ahead log in IndexedDB: that row is the ack. The SharedWorker flushes the rows of the log into one SST file in OPFS and truncates the log. The tab reads the SST files itself." />
</div>
