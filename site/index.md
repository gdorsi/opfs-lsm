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
        setup: A task tracker at 200,000 issues, timed to the last answer. Medians of 5 runs on an Apple M5 Max
        note: The board asks for 6 reads as it opens, all started together. Read one at a time, the 11 screens of the full table are all faster on docstore in a warm tab. In a fresh tab 4 are faster and 5 are slower, the issue most of all.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 8.10 ms, theirs: 15.7 ms, ratio: 1.9× }
          - { measure: "The same board, read again", ours: 1.06 ms, theirs: 11.9 ms, ratio: 11× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 6.68 ms, theirs: 2.18 ms, ratio: 0.33× }
          - { measure: "The same issue, read again", ours: 0.0917 ms, theirs: 0.391 ms, ratio: 4.3× }
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
        setup: TanStack DB, y-indexeddb and automerge-repo's IndexedDB storage
        note: No frames dropped while typing, on any of the four, and the runs do not separate the time of one keystroke.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 299 ms, theirs: 1.02 s, ratio: 3.4× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 105k rows/s, theirs: 9.80k rows/s, ratio: 11× }
          - { measure: "Yjs: cold load of 500 notes", ours: 71.9 ms, theirs: 276 ms, ratio: 3.8× }
          - { measure: "Yjs: reopening right after typing", ours: 16.5 ms, theirs: 8.36 ms, ratio: 0.50× }
          - { measure: "Automerge: cold load of 500 notes", ours: 249 ms, theirs: 377 ms, ratio: 1.5× }
          - { measure: "Automerge: reopening right after typing", ours: 63.6 ms, theirs: 59.0 ms, ratio: 0.93× }
      - title: Your own adapter on kv
        versus: kv against IndexedDB
        stores: [kv, IndexedDB]
        setup: Medians of 5 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 391k ops/s, theirs: 28.0k ops/s, ratio: 14× }
          - { measure: "Random point reads", ours: 506k ops/s, theirs: 16.5k ops/s, ratio: 31× }
          - { measure: "Single put, awaited one at a time", ours: 7.89k ops/s, theirs: 9.24k ops/s, ratio: 0.85× }
          - { measure: "Opening the database in a fresh tab", ours: 5.55 ms, theirs: 0.348 ms, ratio: 0.063× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: Opening a screen
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: The same tracker at 20,000 issues, timed to the last answer. Medians of 5 runs on an Apple M5 Max
        note: Read one at a time, docstore is faster than SQLite on 7 of the 11 screens in a warm tab and slower on 3. In a fresh tab it is faster on 4 and slower on 5, down to 0.52×.
        rows:
          - { measure: "A board, 6 reads at once, in a fresh tab", ours: 7.02 ms, theirs: 8.59 ms, ratio: 1.2× }
          - { measure: "The same board, read again", ours: 0.775 ms, theirs: 1.61 ms, ratio: 2.1× }
          - { measure: "An issue with its comments, in a fresh tab", ours: 5.90 ms, theirs: 4.29 ms, ratio: 0.73× }
          - { measure: "The same issue, read again", ours: 0.0823 ms, theirs: 0.210 ms, ratio: 2.6× }
      - title: Edits and sync
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs on an Apple M5 Max
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 16.9 ms, theirs: 20.3 ms, ratio: 1.2× }
          - { measure: "One edit", ours: 0.222 ms, theirs: 3.40 ms, ratio: 15× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.05 ms, theirs: 10.5 ms, ratio: 5.1× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 10.5 ms, theirs: 17.6 ms, ratio: 1.7× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.427 ms, theirs: 0.404 ms, ratio: 0.94× }
      - title: Sync under open screens
        versus: TanStack DB live queries, docstore against SQLite
        stores: [docstore, SQLite]
        setup: The tracker through TanStack DB, both on demand, with four screens open as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 31 on docstore, 288 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 11.1 ms, theirs: 71.7 ms, ratio: 6.5× }
          - { measure: "First answer: a project's todo column", ours: 24.8 ms, theirs: 42.8 ms, ratio: 1.7× }
          - { measure: "First answer: the 50 latest issues", ours: 9.85 ms, theirs: 10.4 ms, ratio: 1.1× ‡ }
          - { measure: "A sync batch, four screens open", ours: 6.80 ms, theirs: 128 ms, ratio: 19× }
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

Runs in headless Chrome 157 and 158 on an Apple M2 Pro, and on an Apple M5 Max for the task tracker, except its writes at 200,000 issues.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
