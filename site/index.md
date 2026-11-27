---
layout: home
title: opfs-lsm
navbar: false
intro:
  title: Fast local storage for your web app
  menu:
    - text: Adapters
      link: /#adapters
    - text: Under the hood
      link: /#under-the-hood
    - text: Benchmarks
      link: /#our-benchmarks
    - text: Docs
      link: /guide/
    - text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
  notice:
    title: Still under heavy development
    body: We want opfs-lsm to be the building block for the best UX in web apps, and we are still ironing out the fundamentals. Storage is fault-tolerant and heavily tested, so try it, and tell us what you find.
    link: https://github.com/gdorsi/opfs-lsm/issues
adapters:
  - name: TanStack DB
    detail: Live queries over collections, with the whole dataset in the browser.
    replaces: indexedDBCollectionOptions
    bench: "TanStack DB: cold load of 91,000 rows"
    slot: tanstack-db
    guide: /tanstack-db/
    example:
      name: LinearLite
      link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-tanstackdb
  - name: TanStack Query
    detail: Your query cache, saved one entry per query, so a reload shows data before the network answers.
    replaces: idb-keyval
    bench: "TanStack Query: restore of 644 queries"
    slot: tanstack-query
    guide: /tanstack-query/
  - name: Automerge
    detail: Documents that merge edits from every device, saved in the browser so they open offline.
    replaces: IndexedDBStorageAdapter
    bench: "Automerge: cold load of 500 notes"
    slot: automerge
    guide: /automerge/
    example:
      name: Notes
      link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/notes-manager-automerge
  - name: Yjs
    detail: Shared text and drawings, saved in the browser so they open offline and load faster.
    replaces: y-indexeddb
    bench: "Yjs: cold load of 500 notes"
    slot: yjs
    guide: /yjs/
    example:
      name: Whiteboard
      link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/whiteboard-yjs
  - name: Build your own
    detail: kv is an ordered key-value store shared by every tab. Build your own adapter or sync engine on it.
    bench: Random point reads
    slot: kv
    guide: /kv/
bench:
  - title: Against IndexedDB
    theirs: IndexedDB
    groups:
      - title: Opening a screen
        versus: docstore against Dexie
        stores: [docstore, Dexie]
        setup: A task tracker at 200,000 issues, timed to the last answer. Medians of 4 runs on an Apple M5 Max
        note: The board asks for 6 reads as it opens, all started together. Read one at a time, the 11 screens of the full table are all faster on docstore in a warm tab. In a fresh tab 7 are faster and 4 are slower, the issue most of all.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 6.99 ms, theirs: 16.1 ms, ratio: 2.3× }
          - { measure: "The same board, read again", ours: 1.02 ms, theirs: 11.6 ms, ratio: 11× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 4.83 ms, theirs: 2.25 ms, ratio: 0.47× }
          - { measure: "The same issue, read again", ours: 0.0973 ms, theirs: 0.414 ms, ratio: 4.3× }
      - title: Writing a large workspace
        versus: docstore against Dexie
        stores: [docstore, Dexie]
        setup: The same tracker at 200,000 issues, its history written with no pause. Medians of 4 runs on an Apple M5 Max
        note: The history is written faster than kv compacts, so a few batches wait for it. The slowest 0.1% of docstore's sync batches take 303 ms or more, against 52.2 ms on Dexie.
        rows:
          - { measure: "Import, mean of 442 batches of up to 1,000 rows", ours: 14.2 ms, theirs: 51.4 ms, ratio: 3.6× }
          - { measure: "Sync, mean of 8,729 batches of about 50 changes", ours: 2.61 ms, theirs: 9.79 ms, ratio: 3.8× }
          - { measure: "One edit", ours: 0.286 ms, theirs: 0.672 ms, ratio: 2.4× }
      - title: Your library on opfs-lsm
        versus: against each library's IndexedDB storage
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo's IndexedDB storage and, for TanStack Query, idb-keyval
        note: No frames dropped while typing, on any of the four. A Yjs keystroke takes 0.153 ms of the main thread on kv against 0.118 ms on y-indexeddb, and the runs do not separate the two stores on Yjs or on Automerge.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 108 ms, theirs: 591 ms, ratio: 5.5× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 195k rows/s, theirs: 20.3k rows/s, ratio: 9.6× }
          - { measure: "TanStack Query: restore of 644 queries", ours: 5.02 ms, theirs: 6.28 ms, ratio: 1.3× }
          - { measure: "TanStack Query: opening its store", ours: 11.9 ms, theirs: 7.26 ms, ratio: 0.61× }
          - { measure: "Yjs: cold load of 500 notes", ours: 72.3 ms, theirs: 142 ms, ratio: 2.0× }
          - { measure: "Yjs: reopening right after typing", ours: 20.0 ms, theirs: 10.9 ms, ratio: 0.55× }
          - { measure: "Automerge: cold load of 500 notes", ours: 180 ms, theirs: 250 ms, ratio: 1.4× }
          - { measure: "Automerge: reopening right after typing", ours: 41.1 ms, theirs: 48.5 ms, ratio: 1.2× ‡ }
      - title: Your own adapter on kv
        versus: kv against IndexedDB
        stores: [kv, IndexedDB]
        setup: Medians of 4 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 718k ops/s, theirs: 42.9k ops/s, ratio: 17× }
          - { measure: "Random point reads", ours: 907k ops/s, theirs: 20.0k ops/s, ratio: 45× }
          - { measure: "Single put, awaited one at a time", ours: 13.1k ops/s, theirs: 14.6k ops/s, ratio: 0.90× }
          - { measure: "Opening the database in a fresh tab", ours: 7.72 ms, theirs: 23.7 ms, ratio: 3.1× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: Opening a screen
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: The same tracker at 20,000 issues, timed to the last answer. Medians of 4 runs on an Apple M5 Max
        note: Read one at a time, docstore is faster than SQLite on 7 of the 11 screens in a warm tab and slower on 2. In a fresh tab it is faster on 8 and slower on 3, down to 0.62×.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 5.81 ms, theirs: 8.76 ms, ratio: 1.5× }
          - { measure: "The same board, read again", ours: 0.759 ms, theirs: 1.57 ms, ratio: 2.1× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 4.02 ms, theirs: 4.61 ms, ratio: 1.1× }
          - { measure: "The same issue, read again", ours: 0.0890 ms, theirs: 0.229 ms, ratio: 2.6× }
      - title: Edits and sync
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 4 runs on an Apple M5 Max
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 16.9 ms, theirs: 24.2 ms, ratio: 1.4× }
          - { measure: "One edit", ours: 0.204 ms, theirs: 2.54 ms, ratio: 12× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 1.57 ms, theirs: 10.2 ms, ratio: 6.5× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 8.66 ms, theirs: 15.4 ms, ratio: 1.8× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.405 ms, theirs: 0.402 ms, ratio: 0.99× ‡ }
      - title: Sync under open screens
        versus: TanStack DB live queries, docstore against SQLite
        stores: [docstore, SQLite]
        setup: The tracker through TanStack DB, both on demand, with four screens open as live queries while the sync batches land
        note: "Median frames dropped over 426 batches with the screens open: 9 on docstore, 7 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 7.99 ms, theirs: 48.1 ms, ratio: 6.0× }
          - { measure: "First answer: a project's todo column", ours: 16.9 ms, theirs: 21.1 ms, ratio: 1.2× }
          - { measure: "First answer: the 50 latest issues", ours: 6.55 ms, theirs: 7.21 ms, ratio: 1.1× }
          - { measure: "A sync batch, four screens open", ours: 3.71 ms, theirs: 30.2 ms, ratio: 8.1× }
demo:
  count: 100,000
---

## Adapters

Keep your library's API. Its adapter stores the data in opfs-lsm instead of IndexedDB.

<Adapters :adapters="$frontmatter.adapters" :charts="$frontmatter.bench">
<template v-slot:tanstack-db>

```sh
pnpm add @opfs-lsm/tanstack-db @opfs-lsm/docstore @opfs-lsm/kv
```

```ts
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";

const kv = await openDb({ name: "app" }); // [!code ++]
const store = await openDocStore(kv, schema); // [!code ++]
const todos = createCollection(
  indexedDBCollectionOptions({ db, name: "todos", getKey }), // [!code --]
  docstoreCollectionOptions({ collection: store.collection("todos") }), // [!code ++]
);
```

</template>
<template v-slot:tanstack-query>

```sh
pnpm add @opfs-lsm/tanstack-query @opfs-lsm/kv
```

```ts
import { createQueryPersister } from "@opfs-lsm/tanstack-query";

const db = await openDb({ name: "app" }); // [!code ++]
const storage = { getItem: get, setItem: set, removeItem: del }; // [!code --]
const persister = experimental_createQueryPersister({ storage }); // [!code --]
const persister = createQueryPersister(db); // [!code ++]
const queries = { persister: persister.persisterFn };
const queryClient = new QueryClient({ defaultOptions: { queries } });
```

</template>
<template v-slot:automerge>

```sh
pnpm add @opfs-lsm/automerge @opfs-lsm/kv
```

```ts
import { kvStorage } from "@opfs-lsm/automerge";

const db = await openDb({ name: "notes" }); // [!code ++]
const repo = new Repo({
  storage: new IndexedDBStorageAdapter(), // [!code --]
  storage: kvStorage(db), // [!code ++]
});
```

</template>
<template v-slot:yjs>

```sh
pnpm add @opfs-lsm/yjs @opfs-lsm/kv
```

```ts
import { KvPersistence } from "@opfs-lsm/yjs";

const db = await openDb({ name: "notes" }); // [!code ++]
const doc = new Y.Doc();
const persistence = new IndexeddbPersistence("note-1", doc); // [!code --]
const persistence = new KvPersistence(db, "note-1", doc); // [!code ++]
await persistence.whenSynced;
```

</template>
<template v-slot:kv>

```sh
pnpm add @opfs-lsm/kv
```

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "app" });
await db.batch((tx) => {
  tx.put(key, bytes);
});
for await (const { key, value } of db.range({ limit: 50 })) {
  // ...
}
```

</template>
</Adapters>

## What kv gives you

<div class="home-features">
<div>

### Lightweight

The wasm engine loads in parallel with the open, outside your main bundle

```ts
// 19.7 kB gzip in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker loads here, but you
// can already do everything without it
const db = await openDb({ name: "app" });
```

</div>
<div>

### Quota management

A reserve gives space back when the browser refuses a write, and your app picks what to drop

```ts
const db = await openDb({ name: "app" });
db.onStorageFull(({ need }) => evict(need));
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

## Under the hood

<Illustration name="hood" full />

## Our benchmarks

We aim to make web apps faster, and so we optimize for loading multiple queries concurrently and warm navigations.

These benchmarks show our work in this direction.

<Benchmarks :charts="$frontmatter.bench" />

<div class="bench-foot">

Runs in headless Chrome 158 on an Apple M5 Max.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
