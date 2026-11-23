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
  - name: fate
    detail: A cache of what the app has fetched, plus the mutations made while offline.
    replaces: "@nkzw/fate-indexeddb"
    bench: "fate: cold load of 100 lists"
    slot: fate
    guide: /fate/
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
      - title: Storage calls
        versus: kv against IndexedDB
        stores: [kv, IndexedDB]
        setup: Medians of 5 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 391k ops/s, theirs: 28.0k ops/s, ratio: 14× }
          - { measure: "Random point reads", ours: 506k ops/s, theirs: 16.5k ops/s, ratio: 31× }
          - { measure: "Reads of missing keys", ours: 1.00M ops/s, theirs: 15.5k ops/s, ratio: 65× }
          - { measure: "Full ordered scan", ours: 3.09M ops/s, theirs: 379k ops/s, ratio: 8.1× }
          - { measure: "Single put, awaited one at a time", ours: 7.89k ops/s, theirs: 9.24k ops/s, ratio: 0.85× }
          - { measure: "Opening the database in a fresh tab", ours: 5.55 ms, theirs: 0.348 ms, ratio: 0.063× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 299 ms, theirs: 1.02 s, ratio: 3.4× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 105k rows/s, theirs: 9.80k rows/s, ratio: 11× }
          - { measure: "TanStack DB: one row per transaction", ours: 5.04k rows/s, theirs: 3.30k rows/s, ratio: 1.5× ‡ }
          - { measure: "Yjs: cold load of 500 notes", ours: 71.9 ms, theirs: 276 ms, ratio: 3.8× }
          - { measure: "Yjs: editing trace in one burst, no yield", ours: 18.5k edits/s, theirs: 2.13k edits/s, ratio: 8.7× }
          - { measure: "Automerge: cold load of 500 notes", ours: 249 ms, theirs: 377 ms, ratio: 1.5× }
          - { measure: "Automerge: write 500 notes", ours: 668 notes/s, theirs: 627 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 3.14k records/s, theirs: 1.18k records/s, ratio: 2.7× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, main-thread time", ours: 0.156 ms, theirs: 0.130 ms, ratio: 0.83× ‡ }
          - { measure: "Yjs: reopening right after typing", ours: 16.5 ms, theirs: 8.36 ms, ratio: 0.50× }
          - { measure: "Yjs: reopening once kv has settled", ours: 16.5 ms, theirs: 8.20 ms, ratio: 0.50× }
          - { measure: "Automerge: one keystroke, main-thread time", ours: 0.521 ms, theirs: 0.288 ms, ratio: 0.55× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 63.6 ms, theirs: 59.0 ms, ratio: 0.93× }
          - { measure: "Automerge: reopening once kv has settled", ours: 66.3 ms, theirs: 58.8 ms, ratio: 0.89× }
      - title: A task tracker at 200,000 issues, cold
        versus: docstore against Dexie, cold
        stores: [docstore, Dexie]
        setup: The first call in a fresh tab, medians of 5 runs on an Apple M5 Max
        note: Cold, docstore is faster on 5 of the 11 goals and slower on 6. A fresh tab loads each page its rows sit on.
        rows:
          - { measure: "The column a sprint close just emptied", ours: 6.75 ms, theirs: 75.0 ms, ratio: 11× }
          - { measure: "First 50 open issues with a label", ours: 14.5 ms, theirs: 146 ms, ratio: 10× }
          - { measure: "Issues per status in a project", ours: 3.55 ms, theirs: 12.4 ms, ratio: 3.5× }
          - { measure: "Rows at 90% of a project's list", ours: 13.2 ms, theirs: 24.7 ms, ratio: 1.9× }
          - { measure: "Open issues per person, top 10", ours: 5.09 ms, theirs: 8.24 ms, ratio: 1.6× }
          - { measure: "First 20 issues whose title contains a word", ours: 9.93 ms, theirs: 6.46 ms, ratio: 0.65× }
          - { measure: "The 50 most recently updated issues", ours: 4.56 ms, theirs: 2.28 ms, ratio: 0.50× }
          - { measure: "First 50 open issues by priority, with counts", ours: 19.2 ms, theirs: 8.09 ms, ratio: 0.42× }
          - { measure: "First 50 open issues assigned to a person", ours: 14.0 ms, theirs: 3.21 ms, ratio: 0.23× }
          - { measure: "An issue with its comments and their authors", ours: 7.42 ms, theirs: 1.48 ms, ratio: 0.20× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 13.5 ms, theirs: 2.11 ms, ratio: 0.16× }
      - title: A task tracker at 200,000 issues, warm
        versus: docstore against Dexie, warm
        stores: [docstore, Dexie]
        setup: The same call again, medians of 5 runs on an Apple M5 Max
        note: Warm, docstore is faster on all 11 goals.
        rows:
          - { measure: "First 50 open issues with a label", ours: 0.305 ms, theirs: 142 ms, ratio: 460× }
          - { measure: "Issues per status in a project", ours: 0.118 ms, theirs: 7.96 ms, ratio: 67× }
          - { measure: "Rows at 90% of a project's list", ours: 0.356 ms, theirs: 23.7 ms, ratio: 67× }
          - { measure: "The column a sprint close just emptied", ours: 1.32 ms, theirs: 73.3 ms, ratio: 56× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.177 ms, theirs: 5.23 ms, ratio: 30× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.444 ms, theirs: 6.30 ms, ratio: 14× }
          - { measure: "Open issues per person, top 10", ours: 0.620 ms, theirs: 6.40 ms, ratio: 10× }
          - { measure: "An issue with its comments and their authors", ours: 0.0833 ms, theirs: 0.417 ms, ratio: 5.0× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.325 ms, theirs: 1.56 ms, ratio: 4.8× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.271 ms, theirs: 1.00 ms, ratio: 3.7× }
          - { measure: "The 50 most recently updated issues", ours: 0.422 ms, theirs: 1.10 ms, ratio: 2.6× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 13.1 ms, theirs: 27.8 ms, ratio: 2.1× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 12.6 ms, theirs: 21.5 ms, ratio: 1.7× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.55 ms, theirs: 13.2 ms, ratio: 5.2× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 45.8 ms, theirs: 71.1 ms, ratio: 1.6× }
          - { measure: "One edit", ours: 0.336 ms, theirs: 2.79 ms, ratio: 8.3× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.503 ms, theirs: 0.554 ms, ratio: 1.1× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 6.
        note: Dexie, the third store in the full table, beats docstore at opening the store and on 7 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 4.51 ms, theirs: 5.53 ms, ratio: 1.2× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 9.07 ms, theirs: 7.16 ms, ratio: 0.79× }
          - { measure: "The column a sprint close just emptied", ours: 6.24 ms, theirs: 6.10 ms, ratio: 0.98× ‡ }
          - { measure: "Rows at 90% of a project's list", ours: 10.3 ms, theirs: 6.22 ms, ratio: 0.61× }
          - { measure: "An issue with its comments and their authors", ours: 7.11 ms, theirs: 6.24 ms, ratio: 0.88× }
          - { measure: "First 50 open issues by priority, with counts", ours: 13.8 ms, theirs: 7.43 ms, ratio: 0.54× }
          - { measure: "First 50 open issues with a label", ours: 10.2 ms, theirs: 13.4 ms, ratio: 1.3× }
          - { measure: "First 50 open issues assigned to a person", ours: 10.1 ms, theirs: 7.83 ms, ratio: 0.77× }
          - { measure: "The 50 most recently updated issues", ours: 4.95 ms, theirs: 6.93 ms, ratio: 1.4× }
          - { measure: "Open issues per person, top 10", ours: 5.47 ms, theirs: 7.11 ms, ratio: 1.3× }
          - { measure: "First 20 issues whose title contains a word", ours: 8.12 ms, theirs: 6.00 ms, ratio: 0.74× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 5 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.176 ms, theirs: 0.173 ms, ratio: 0.98× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.362 ms, theirs: 0.537 ms, ratio: 1.5× }
          - { measure: "The column a sprint close just emptied", ours: 0.755 ms, theirs: 0.292 ms, ratio: 0.39× }
          - { measure: "Rows at 90% of a project's list", ours: 0.417 ms, theirs: 0.369 ms, ratio: 0.89× }
          - { measure: "An issue with its comments and their authors", ours: 0.131 ms, theirs: 0.323 ms, ratio: 2.5× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.635 ms, theirs: 0.431 ms, ratio: 0.68× }
          - { measure: "First 50 open issues with a label", ours: 0.454 ms, theirs: 3.99 ms, ratio: 8.8× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.427 ms, theirs: 0.568 ms, ratio: 1.3× }
          - { measure: "The 50 most recently updated issues", ours: 0.527 ms, theirs: 0.817 ms, ratio: 1.6× }
          - { measure: "Open issues per person, top 10", ours: 0.416 ms, theirs: 0.370 ms, ratio: 0.89× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.259 ms, theirs: 0.305 ms, ratio: 1.2× ‡ }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 12.6 ms, theirs: 85.8 ms, ratio: 6.8× }
          - { measure: "First query in a fresh tab", ours: 97.2 ms, theirs: 92.2 ms, ratio: 0.95× ‡ }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 160k rows/s, theirs: 89.9k rows/s, ratio: 1.8× }
          - { measure: "10 rows by id", ours: 2.91k queries/s, theirs: 1.29k queries/s, ratio: 2.3× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 31 on docstore, 288 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 11.1 ms, theirs: 71.7 ms, ratio: 6.5× }
          - { measure: "A sync batch, four screens open", ours: 6.80 ms, theirs: 128 ms, ratio: 19× }
          - { measure: "A sync batch, no screen open", ours: 1.58 ms, theirs: 28.3 ms, ratio: 18× }
          - { measure: "First answer: a project's todo column", ours: 24.8 ms, theirs: 42.8 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 29.0 ms, theirs: 41.2 ms, ratio: 1.4× }
          - { measure: "First answer: a person's open issues", ours: 6.24 ms, theirs: 8.51 ms, ratio: 1.4× }
          - { measure: "First answer: the 50 latest issues", ours: 9.85 ms, theirs: 10.4 ms, ratio: 1.1× ‡ }
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
<template v-slot:fate>

```sh
pnpm add @opfs-lsm/fate @opfs-lsm/kv
```

```ts
import { kvStorage } from "@opfs-lsm/fate";

const db = await openDb({ name: "app" }); // [!code ++]
const persistence = createPersistence({
  key: "acct:1",
  storage: createIndexedDBStorage(), // [!code --]
  storage: kvStorage(db), // [!code ++]
});
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
// 19.4 kB gzip in your main bundle
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

[How it works](../docs/how-it-works.md) · [What kv promises](../docs/how-it-works.md#consistent-not-durable) · [Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

## Our benchmarks

<Benchmarks :charts="$frontmatter.bench" />

<div class="bench-foot">

Runs in headless Chrome 157 on an Apple M2 Pro, and on an Apple M5 Max for the tracker at 200,000 issues.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
