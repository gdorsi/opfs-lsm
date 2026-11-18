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
    example:
      name: LinearLite on fate
      link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-fate
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
        setup: Medians of 10 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 494k ops/s, theirs: 42.0k ops/s, ratio: 12× }
          - { measure: "Random point reads", ours: 592k ops/s, theirs: 21.9k ops/s, ratio: 27× }
          - { measure: "Reads of missing keys", ours: 1.89M ops/s, theirs: 24.4k ops/s, ratio: 78× }
          - { measure: "Full ordered scan", ours: 1.38M ops/s, theirs: 678k ops/s, ratio: 2.0× }
          - { measure: "Single put, awaited one at a time", ours: 13.0k ops/s, theirs: 14.7k ops/s, ratio: 0.9× }
          - { measure: "Opening the database in a fresh tab", ours: 6.7 ms, theirs: 0.9 ms, ratio: 0.1× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        note: The Automerge write, 1.1×, is about even.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 451k rows/s, theirs: 137k rows/s, ratio: 3.3× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 131k rows/s, theirs: 19.7k rows/s, ratio: 6.7× }
          - { measure: "TanStack DB: one row per transaction", ours: 5.7k rows/s, theirs: 6.9k rows/s, ratio: 0.8× }
          - { measure: "Yjs: cold load of 500 notes", ours: 12.7k notes/s, theirs: 3.0k notes/s, ratio: 4.2× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 36.0k edits/s, theirs: 2.1k edits/s, ratio: 17× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.8k notes/s, theirs: 2.0k notes/s, ratio: 1.4× }
          - { measure: "Automerge: write 500 notes", ours: 922 notes/s, theirs: 875 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 4.1k records/s, theirs: 2.1k records/s, ratio: 2.0× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.15 ms, theirs: 0.10 ms, ratio: 0.7× }
          - { measure: "Yjs: reopening right after typing", ours: 12 ms, theirs: 5.4 ms, ratio: 0.5× }
          - { measure: "Yjs: reopening once kv has settled", ours: 12 ms, theirs: 5.3 ms, ratio: 0.5× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.29 ms, theirs: 0.28 ms, ratio: 0.9× }
          - { measure: "Automerge: reopening right after typing", ours: 47 ms, theirs: 42 ms, ratio: 0.9× }
          - { measure: "Automerge: reopening once kv has settled", ours: 48 ms, theirs: 43 ms, ratio: 0.9× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 3 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 13 ms, theirs: 22 ms, ratio: 1.6× }
          - { measure: "Import, 47 batches of up to 1,000 rows", ours: 0.62 s, theirs: 0.92 s, ratio: 1.5× }
          - { measure: "Sync, 851 batches of about 50 changes", ours: 2.5 s, theirs: 10.9 s, ratio: 4.4× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 50 ms, theirs: 72 ms, ratio: 1.4× }
          - { measure: "One edit", ours: 0.36 ms, theirs: 3.2 ms, ratio: 9.0× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.56 ms, theirs: 0.47 ms, ratio: 0.8× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore and SQLite are within 1.5× of each other on 10 of the 11 goals.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on 5 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 2.7 ms, theirs: 4.0 ms, ratio: 1.5× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 7.2 ms, theirs: 5.2 ms, ratio: 0.7× }
          - { measure: "The column a sprint close just emptied", ours: 4.3 ms, theirs: 4.3 ms, ratio: 1.0× }
          - { measure: "Rows at 90% of a project's list", ours: 9.4 ms, theirs: 4.5 ms, ratio: 0.5× }
          - { measure: "An issue with its comments and their authors", ours: 4.7 ms, theirs: 4.5 ms, ratio: 1.0× }
          - { measure: "First 50 open issues by priority, with counts", ours: 9.9 ms, theirs: 7.0 ms, ratio: 0.7× }
          - { measure: "First 50 open issues with a label", ours: 4.9 ms, theirs: 7.0 ms, ratio: 1.4× }
          - { measure: "First 50 open issues assigned to a person", ours: 8.4 ms, theirs: 5.6 ms, ratio: 0.7× }
          - { measure: "The 50 most recently updated issues", ours: 3.4 ms, theirs: 5.1 ms, ratio: 1.5× }
          - { measure: "Open issues per person, top 10", ours: 3.6 ms, theirs: 5.1 ms, ratio: 1.4× }
          - { measure: "First 20 issues whose title contains a word", ours: 6.5 ms, theirs: 6.2 ms, ratio: 1.0× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.17 ms, theirs: 0.14 ms, ratio: 0.8× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.32 ms, theirs: 0.41 ms, ratio: 1.3× }
          - { measure: "The column a sprint close just emptied", ours: 0.91 ms, theirs: 0.24 ms, ratio: 0.3× }
          - { measure: "Rows at 90% of a project's list", ours: 0.96 ms, theirs: 0.31 ms, ratio: 0.3× }
          - { measure: "An issue with its comments and their authors", ours: 0.092 ms, theirs: 0.25 ms, ratio: 2.7× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.70 ms, theirs: 1.1 ms, ratio: 1.6× }
          - { measure: "First 50 open issues with a label", ours: 0.16 ms, theirs: 1.3 ms, ratio: 7.7× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.28 ms, theirs: 0.44 ms, ratio: 1.6× }
          - { measure: "The 50 most recently updated issues", ours: 0.39 ms, theirs: 0.68 ms, ratio: 1.7× }
          - { measure: "Open issues per person, top 10", ours: 0.55 ms, theirs: 0.29 ms, ratio: 0.5× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.18 ms, theirs: 0.74 ms, ratio: 4.1× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 7.2 ms, theirs: 37.7 ms, ratio: 5.2× }
          - { measure: "First query in a fresh tab", ours: 63.1 ms, theirs: 65.6 ms, ratio: 1.0× }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 205k rows/s, theirs: 132k rows/s, ratio: 1.6× }
          - { measure: "10 rows by id", ours: 5.3k queries/s, theirs: 2.2k queries/s, ratio: 2.4× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 0 on docstore, 81 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 8.9 ms, theirs: 48 ms, ratio: 5.3× }
          - { measure: "A sync batch, four screens open", ours: 3.5 ms, theirs: 85 ms, ratio: 24× }
          - { measure: "A sync batch, no screen open", ours: 1.3 ms, theirs: 23 ms, ratio: 19× }
          - { measure: "First answer: a project's todo column", ours: 18.7 ms, theirs: 31.8 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 11.9 ms, theirs: 8.4 ms, ratio: 0.7× }
          - { measure: "First answer: a person's open issues", ours: 5.2 ms, theirs: 6.8 ms, ratio: 1.3× }
          - { measure: "First answer: the 50 latest issues", ours: 6.7 ms, theirs: 7.7 ms, ratio: 1.2× }
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
// 18.8 kB gzip in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker loads here, but you
// can already do everything without it
const db = await openDb({ name: "app" });
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

## Under the hood

<div class="home-lede">

A write is one row in a write-ahead log, a list of recent writes kept in IndexedDB, and the other tabs of your app hear about it over a BroadcastChannel, a message channel between tabs. One SharedWorker, a background script that all those tabs share, then moves the log into sorted files in OPFS, the browser's private file system.

</div>

[How it works](../docs/how-it-works.md) · [Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

<Illustration name="hood" full />

## Our benchmarks

<Benchmarks :charts="$frontmatter.bench" />

<div class="bench-foot">

Every run on an Apple M5 Max, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
