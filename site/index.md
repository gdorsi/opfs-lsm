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
        note: The board asks for 6 reads as it opens, all started together. Read one at a time, the 11 screens of the full table are all faster on docstore in a warm tab. In a fresh tab 6 are faster and 4 are slower, the issue most of all.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 6.67 ms, theirs: 14.8 ms, ratio: 2.2× }
          - { measure: "The same board, read again", ours: 0.997 ms, theirs: 12.8 ms, ratio: 13× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 4.58 ms, theirs: 1.96 ms, ratio: 0.43× }
          - { measure: "The same issue, read again", ours: 0.101 ms, theirs: 0.367 ms, ratio: 3.6× }
      - title: Writing a large workspace
        versus: docstore against Dexie
        stores: [docstore, Dexie]
        setup: The same tracker at 200,000 issues, its history written with no pause. Medians of 5 runs on an Apple M2 Pro
        note: The history is written faster than kv compacts, so a few batches wait for it. The slowest 0.1% of docstore's sync batches take 467 ms or more, against 71.7 ms on Dexie.
        rows:
          - { measure: "Import, mean of 442 batches of up to 1,000 rows", ours: 20.6 ms, theirs: 79.6 ms, ratio: 3.9× }
          - { measure: "Sync, mean of 8,729 batches of about 50 changes", ours: 4.21 ms, theirs: 14.3 ms, ratio: 3.4× }
          - { measure: "One edit", ours: 0.414 ms, theirs: 0.900 ms, ratio: 2.2× }
      - title: Your library on opfs-lsm
        versus: against each library's IndexedDB storage
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo's IndexedDB storage and, for TanStack Query, idb-keyval
        note: No frames dropped while typing, on any of the four. A Yjs keystroke takes 0.153 ms of the main thread on kv against 0.125 ms on y-indexeddb, and the runs do not separate Automerge's two.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 110 ms, theirs: 594 ms, ratio: 5.4× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 196k rows/s, theirs: 20.1k rows/s, ratio: 9.7× }
          - { measure: "TanStack Query: restore of 644 queries", ours: 5.09 ms, theirs: 6.22 ms, ratio: 1.2× }
          - { measure: "TanStack Query: opening its store", ours: 12.8 ms, theirs: 7.22 ms, ratio: 0.57× }
          - { measure: "Yjs: cold load of 500 notes", ours: 73.0 ms, theirs: 146 ms, ratio: 2.0× }
          - { measure: "Yjs: reopening right after typing", ours: 19.2 ms, theirs: 10.4 ms, ratio: 0.54× }
          - { measure: "Automerge: cold load of 500 notes", ours: 180 ms, theirs: 249 ms, ratio: 1.4× }
          - { measure: "Automerge: reopening right after typing", ours: 44.8 ms, theirs: 45.6 ms, ratio: 1.0× ‡ }
      - title: Your own adapter on kv
        versus: kv against IndexedDB
        stores: [kv, IndexedDB]
        setup: Medians of 4 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 748k ops/s, theirs: 45.4k ops/s, ratio: 16× }
          - { measure: "Random point reads", ours: 846k ops/s, theirs: 20.5k ops/s, ratio: 41× }
          - { measure: "Single put, awaited one at a time", ours: 13.9k ops/s, theirs: 14.8k ops/s, ratio: 0.94× }
          - { measure: "Opening the database in a fresh tab", ours: 9.14 ms, theirs: 24.5 ms, ratio: 2.7× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: Opening a screen
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: The same tracker at 20,000 issues, timed to the last answer. Medians of 5 runs on an Apple M5 Max
        note: Read one at a time, docstore is faster than SQLite on 8 of the 11 screens in a warm tab and slower on 3. In a fresh tab it is faster on 6 and slower on 3, down to 0.63×.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 6.03 ms, theirs: 8.98 ms, ratio: 1.5× }
          - { measure: "The same board, read again", ours: 0.761 ms, theirs: 1.57 ms, ratio: 2.1× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 4.49 ms, theirs: 4.61 ms, ratio: 1.0× ‡ }
          - { measure: "The same issue, read again", ours: 0.0870 ms, theirs: 0.207 ms, ratio: 2.4× }
      - title: Edits and sync
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs on an Apple M5 Max
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 18.3 ms, theirs: 24.3 ms, ratio: 1.3× }
          - { measure: "One edit", ours: 0.213 ms, theirs: 3.61 ms, ratio: 17× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 1.71 ms, theirs: 10.8 ms, ratio: 6.3× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 9.16 ms, theirs: 16.5 ms, ratio: 1.8× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.411 ms, theirs: 0.395 ms, ratio: 0.96× ‡ }
      - title: Sync under open screens
        versus: TanStack DB live queries, docstore against SQLite
        stores: [docstore, SQLite]
        setup: The tracker through TanStack DB, both on demand, with four screens open as live queries while the sync batches land
        note: "Median frames dropped over 426 batches with the screens open: 8.5 on docstore, 70 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 8.99 ms, theirs: 54.6 ms, ratio: 6.1× }
          - { measure: "First answer: a project's todo column", ours: 17.1 ms, theirs: 27.8 ms, ratio: 1.6× }
          - { measure: "First answer: the 50 latest issues", ours: 6.50 ms, theirs: 7.36 ms, ratio: 1.1× }
          - { measure: "A sync batch, four screens open", ours: 3.74 ms, theirs: 76.4 ms, ratio: 20× }
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

Runs in headless Chrome 158 on an Apple M5 Max, except the writes at 200,000 issues, which ran on an Apple M2 Pro.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
