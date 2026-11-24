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
        setup: TanStack DB, y-indexeddb and automerge-repo's IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 299 ms, theirs: 1.02 s, ratio: 3.4× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 105k rows/s, theirs: 9.80k rows/s, ratio: 11× }
          - { measure: "TanStack DB: one row per transaction", ours: 5.04k rows/s, theirs: 3.30k rows/s, ratio: 1.5× ‡ }
          - { measure: "Yjs: cold load of 500 notes", ours: 71.9 ms, theirs: 276 ms, ratio: 3.8× }
          - { measure: "Yjs: editing trace in one burst, no yield", ours: 18.5k edits/s, theirs: 2.13k edits/s, ratio: 8.7× }
          - { measure: "Automerge: cold load of 500 notes", ours: 249 ms, theirs: 377 ms, ratio: 1.5× }
          - { measure: "Automerge: write 500 notes", ours: 668 notes/s, theirs: 627 notes/s, ratio: 1.1× }
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
        note: Cold, docstore is faster on 4 of the 11 goals and slower on 5, and the runs do not separate the other 2. A fresh tab loads each page its rows sit on.
        rows:
          - { measure: "The column a sprint close just emptied", ours: 8.27 ms, theirs: 60.8 ms, ratio: 7.3× }
          - { measure: "Issues per status in a project", ours: 3.48 ms, theirs: 8.47 ms, ratio: 2.4× }
          - { measure: "Rows at 90% of a project's list", ours: 12.8 ms, theirs: 22.1 ms, ratio: 1.7× }
          - { measure: "Open issues per person, top 10", ours: 5.90 ms, theirs: 9.78 ms, ratio: 1.7× }
          - { measure: "First 50 open issues with a label", ours: 12.5 ms, theirs: 13.9 ms, ratio: 1.1× ‡ }
          - { measure: "First 20 issues whose title contains a word", ours: 8.50 ms, theirs: 8.83 ms, ratio: 1.0× ‡ }
          - { measure: "First 50 open issues assigned to a person", ours: 4.74 ms, theirs: 4.35 ms, ratio: 0.92× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 4.54 ms, theirs: 2.83 ms, ratio: 0.62× }
          - { measure: "First 50 open issues by priority, with counts", ours: 16.2 ms, theirs: 9.08 ms, ratio: 0.56× }
          - { measure: "The 50 most recently updated issues", ours: 4.23 ms, theirs: 2.10 ms, ratio: 0.50× }
          - { measure: "An issue with its comments and their authors", ours: 6.68 ms, theirs: 2.18 ms, ratio: 0.33× }
      - title: A task tracker at 200,000 issues, warm
        versus: docstore against Dexie, warm
        stores: [docstore, Dexie]
        setup: The same call again, medians of 5 runs on an Apple M5 Max
        note: Warm, docstore is faster on all 11 goals.
        rows:
          - { measure: "Rows at 90% of a project's list", ours: 0.354 ms, theirs: 22.1 ms, ratio: 63× }
          - { measure: "Issues per status in a project", ours: 0.129 ms, theirs: 7.00 ms, ratio: 54× }
          - { measure: "The column a sprint close just emptied", ours: 1.74 ms, theirs: 61.6 ms, ratio: 35× }
          - { measure: "First 50 open issues with a label", ours: 0.289 ms, theirs: 9.32 ms, ratio: 32× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.146 ms, theirs: 3.70 ms, ratio: 25× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.373 ms, theirs: 6.23 ms, ratio: 17× }
          - { measure: "Open issues per person, top 10", ours: 0.557 ms, theirs: 5.61 ms, ratio: 10× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.255 ms, theirs: 1.52 ms, ratio: 6.0× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.207 ms, theirs: 1.04 ms, ratio: 5.0× }
          - { measure: "An issue with its comments and their authors", ours: 0.0917 ms, theirs: 0.391 ms, ratio: 4.3× }
          - { measure: "The 50 most recently updated issues", ours: 0.492 ms, theirs: 1.06 ms, ratio: 2.2× }
      - title: A board at 200,000 issues, 6 reads at once
        versus: docstore against Dexie
        stores: [docstore, Dexie]
        setup: Timed to the last answer, medians of 5 runs on an Apple M5 Max
        note: The 6 reads a project's board asks for as it opens. Cold, they end 1.1× sooner started together than one after the other, on both stores.
        rows:
          - { measure: "Started together, cold", ours: 8.10 ms, theirs: 15.7 ms, ratio: 1.9× }
          - { measure: "One after the other, cold", ours: 9.32 ms, theirs: 17.6 ms, ratio: 1.9× }
          - { measure: "Started together, warm", ours: 1.06 ms, theirs: 11.9 ms, ratio: 11× }
          - { measure: "One after the other, warm", ours: 1.04 ms, theirs: 12.4 ms, ratio: 12× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 16.9 ms, theirs: 20.3 ms, ratio: 1.2× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 10.5 ms, theirs: 17.6 ms, ratio: 1.7× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.05 ms, theirs: 10.5 ms, ratio: 5.1× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 33.9 ms, theirs: 52.8 ms, ratio: 1.6× }
          - { measure: "One edit", ours: 0.222 ms, theirs: 3.40 ms, ratio: 15× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.427 ms, theirs: 0.404 ms, ratio: 0.94× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 5.
        note: Dexie, the third store in the full table, opens the store in the same time as docstore and has the lower cold median on 5 of the 11 screens.
        rows:
          - { measure: "Issues per status in a project", ours: 3.64 ms, theirs: 3.79 ms, ratio: 1.0× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 3.91 ms, theirs: 4.84 ms, ratio: 1.2× }
          - { measure: "The column a sprint close just emptied", ours: 5.52 ms, theirs: 4.20 ms, ratio: 0.76× }
          - { measure: "Rows at 90% of a project's list", ours: 7.90 ms, theirs: 4.35 ms, ratio: 0.55× }
          - { measure: "An issue with its comments and their authors", ours: 5.90 ms, theirs: 4.29 ms, ratio: 0.73× }
          - { measure: "First 50 open issues by priority, with counts", ours: 9.65 ms, theirs: 5.05 ms, ratio: 0.52× }
          - { measure: "First 50 open issues with a label", ours: 8.28 ms, theirs: 9.55 ms, ratio: 1.2× }
          - { measure: "First 50 open issues assigned to a person", ours: 4.57 ms, theirs: 5.38 ms, ratio: 1.2× }
          - { measure: "The 50 most recently updated issues", ours: 3.85 ms, theirs: 4.84 ms, ratio: 1.3× }
          - { measure: "Open issues per person, top 10", ours: 5.05 ms, theirs: 4.86 ms, ratio: 0.96× ‡ }
          - { measure: "First 20 issues whose title contains a word", ours: 6.49 ms, theirs: 4.39 ms, ratio: 0.68× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.0960 ms, theirs: 0.126 ms, ratio: 1.3× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.170 ms, theirs: 0.422 ms, ratio: 2.5× }
          - { measure: "The column a sprint close just emptied", ours: 0.492 ms, theirs: 0.205 ms, ratio: 0.42× }
          - { measure: "Rows at 90% of a project's list", ours: 0.267 ms, theirs: 0.286 ms, ratio: 1.1× ‡ }
          - { measure: "An issue with its comments and their authors", ours: 0.0823 ms, theirs: 0.210 ms, ratio: 2.6× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.374 ms, theirs: 0.321 ms, ratio: 0.86× }
          - { measure: "First 50 open issues with a label", ours: 0.295 ms, theirs: 2.75 ms, ratio: 9.3× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.202 ms, theirs: 0.424 ms, ratio: 2.1× }
          - { measure: "The 50 most recently updated issues", ours: 0.353 ms, theirs: 0.568 ms, ratio: 1.6× }
          - { measure: "Open issues per person, top 10", ours: 0.346 ms, theirs: 0.281 ms, ratio: 0.81× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.169 ms, theirs: 0.207 ms, ratio: 1.2× }
      - title: Its board, 6 reads at once
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: The 6 reads a project's board asks for as it opens, timed to the last answer
        note: Warm, docstore takes the same time either way. Each read is work on the tab's main thread, with nothing to wait for.
        rows:
          - { measure: "Started together, cold", ours: 7.02 ms, theirs: 8.59 ms, ratio: 1.2× }
          - { measure: "One after the other, cold", ours: 7.49 ms, theirs: 8.65 ms, ratio: 1.2× }
          - { measure: "Started together, warm", ours: 0.775 ms, theirs: 1.61 ms, ratio: 2.1× }
          - { measure: "One after the other, warm", ours: 0.771 ms, theirs: 1.72 ms, ratio: 2.2× }
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

Runs in headless Chrome 157 on an Apple M2 Pro, and on an Apple M5 Max for the task tracker.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
