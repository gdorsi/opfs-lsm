---
layout: home
title: opfs-lsm
intro:
  title: Fast local storage for your web app
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
fits:
  - case: Offline-first apps
    detail: The whole dataset lives in the browser, and the UI queries it there
    name: TanStack DB
    stores: every row
    adapters:
      - name: TanStack DB
        library: TanStack DB collections
        package: "@opfs-lsm/tanstack-db"
        slot: tanstack-db
        guide: /tanstack-db/
        example:
          name: LinearLite
          link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-tanstackdb
  - case: A cache of server data
    detail: What the app has fetched, plus the mutations made while offline
    name: fate
    stores: cached records and queued mutations
    adapters:
      - name: fate
        library: fate client
        package: "@opfs-lsm/fate"
        slot: fate
        guide: /fate/
        example:
          name: LinearLite on fate
          link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-fate
  - case: Collaborative documents
    detail: Persist your CRDT locally, so it is available offline and loads faster
    name: Yjs or Automerge
    stores: document updates
    adapters:
      - name: Yjs
        library: Y.Doc
        package: "@opfs-lsm/yjs"
        slot: yjs
        guide: /yjs/
        example:
          name: Whiteboard
          link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/whiteboard-yjs
      - name: Automerge
        library: automerge-repo
        package: "@opfs-lsm/automerge"
        slot: automerge
        guide: /automerge/
        example:
          name: Notes
          link: https://github.com/gdorsi/opfs-lsm/tree/main/examples/notes-manager-automerge
  - case: Your own sync engine
    detail: kv is a faster alternative to IndexedDB with a better API, to make your sync engine load faster
    name: kv
    stores: your keys and bytes
    adapters:
      - name: kv
        library: your sync engine
        package: "@opfs-lsm/kv"
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
          - { measure: "Random writes, batches of 1,000", ours: 432k ops/s, theirs: 30.2k ops/s, ratio: 14× }
          - { measure: "Random point reads", ours: 488k ops/s, theirs: 16.4k ops/s, ratio: 30× }
          - { measure: "Reads of missing keys", ours: 1.64M ops/s, theirs: 17.8k ops/s, ratio: 92× }
          - { measure: "Full ordered scan", ours: 1.03M ops/s, theirs: 604k ops/s, ratio: 1.7× }
          - { measure: "Single put, awaited one at a time", ours: 7.4k ops/s, theirs: 9.1k ops/s, ratio: 0.8× }
          - { measure: "Opening the database in a fresh tab", ours: 7.8 ms, theirs: 1.2 ms, ratio: 0.2× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        note: The Automerge write, 1.1×, is about even.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 176k rows/s, theirs: 112k rows/s, ratio: 1.6× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 115k rows/s, theirs: 17.2k rows/s, ratio: 6.7× }
          - { measure: "TanStack DB: one row per transaction", ours: 2.5k rows/s, theirs: 4.7k rows/s, ratio: 0.5× }
          - { measure: "Yjs: cold load of 500 notes", ours: 9.5k notes/s, theirs: 2.0k notes/s, ratio: 4.8× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 33.2k edits/s, theirs: 1.4k edits/s, ratio: 23× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.2k notes/s, theirs: 1.1k notes/s, ratio: 2.0× }
          - { measure: "Automerge: write 500 notes", ours: 821 notes/s, theirs: 743 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 3.4k records/s, theirs: 1.0k records/s, ratio: 3.3× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.28 ms, theirs: 0.23 ms, ratio: 0.8× }
          - { measure: "Yjs: reopening right after typing", ours: 16 ms, theirs: 7.2 ms, ratio: 0.5× }
          - { measure: "Yjs: reopening once kv has settled", ours: 22 ms, theirs: 7.3 ms, ratio: 0.3× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.61 ms, theirs: 0.56 ms, ratio: 0.9× }
          - { measure: "Automerge: reopening right after typing", ours: 62 ms, theirs: 57 ms, ratio: 0.9× }
          - { measure: "Automerge: reopening once kv has settled", ours: 64 ms, theirs: 56 ms, ratio: 0.9× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 3 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 18 ms, theirs: 24 ms, ratio: 1.3× }
          - { measure: "Import, 47 batches of up to 1,000 rows", ours: 0.85 s, theirs: 1.0 s, ratio: 1.2× }
          - { measure: "Sync, 851 batches of about 50 changes", ours: 3.3 s, theirs: 11.3 s, ratio: 3.4× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 81 ms, theirs: 88 ms, ratio: 1.1× }
          - { measure: "One edit", ours: 0.73 ms, theirs: 1.1 ms, ratio: 1.5× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.69 ms, theirs: 0.54 ms, ratio: 0.8× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is slower than SQLite on most goals.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on most cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 5.3 ms, theirs: 5.3 ms, ratio: 1.0× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 8.3 ms, theirs: 6.8 ms, ratio: 0.8× }
          - { measure: "The column a sprint close just emptied", ours: 5.5 ms, theirs: 5.9 ms, ratio: 1.1× }
          - { measure: "Rows at 90% of a project's list", ours: 12.0 ms, theirs: 5.9 ms, ratio: 0.5× }
          - { measure: "An issue with its comments and their authors", ours: 6.3 ms, theirs: 5.8 ms, ratio: 0.9× }
          - { measure: "First 50 open issues by priority, with counts", ours: 16.3 ms, theirs: 8.7 ms, ratio: 0.5× }
          - { measure: "First 50 open issues with a label", ours: 6.2 ms, theirs: 8.7 ms, ratio: 1.4× }
          - { measure: "First 50 open issues assigned to a person", ours: 9.0 ms, theirs: 7.3 ms, ratio: 0.8× }
          - { measure: "The 50 most recently updated issues", ours: 3.8 ms, theirs: 6.5 ms, ratio: 1.7× }
          - { measure: "Open issues per person, top 10", ours: 16.4 ms, theirs: 6.8 ms, ratio: 0.4× }
          - { measure: "First 20 issues whose title contains a word", ours: 7.5 ms, theirs: 7.7 ms, ratio: 1.0× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest, counting a tie on the priority page.
        rows:
          - { measure: "Issues per status in a project", ours: 0.30 ms, theirs: 0.18 ms, ratio: 0.6× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.47 ms, theirs: 0.53 ms, ratio: 1.1× }
          - { measure: "The column a sprint close just emptied", ours: 1.4 ms, theirs: 0.29 ms, ratio: 0.2× }
          - { measure: "Rows at 90% of a project's list", ours: 1.3 ms, theirs: 0.38 ms, ratio: 0.3× }
          - { measure: "An issue with its comments and their authors", ours: 0.16 ms, theirs: 0.32 ms, ratio: 2.0× }
          - { measure: "First 50 open issues by priority, with counts", ours: 1.4 ms, theirs: 1.4 ms, ratio: 1.0× }
          - { measure: "First 50 open issues with a label", ours: 0.27 ms, theirs: 1.6 ms, ratio: 5.9× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.42 ms, theirs: 0.50 ms, ratio: 1.2× }
          - { measure: "The 50 most recently updated issues", ours: 0.63 ms, theirs: 0.81 ms, ratio: 1.3× }
          - { measure: "Open issues per person, top 10", ours: 4.5 ms, theirs: 0.36 ms, ratio: 0.08× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.30 ms, theirs: 0.87 ms, ratio: 2.9× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 12.0 ms, theirs: 48.1 ms, ratio: 4.0× }
          - { measure: "First query in a fresh tab", ours: 88.1 ms, theirs: 88.1 ms, ratio: 1.0× }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 131k rows/s, theirs: 90.7k rows/s, ratio: 1.4× }
          - { measure: "10 rows by id", ours: 3.6k queries/s, theirs: 1.6k queries/s, ratio: 2.3× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 0 on docstore, 184 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 9.6 ms, theirs: 57 ms, ratio: 5.9× }
          - { measure: "A sync batch, four screens open", ours: 4.7 ms, theirs: 108 ms, ratio: 23× }
          - { measure: "A sync batch, no screen open", ours: 1.6 ms, theirs: 26 ms, ratio: 16× }
          - { measure: "First answer: a project's todo column", ours: 23.4 ms, theirs: 39.8 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 13.0 ms, theirs: 10.3 ms, ratio: 0.8× }
          - { measure: "First answer: a person's open issues", ours: 6.3 ms, theirs: 8.1 ms, ratio: 1.3× }
          - { measure: "First answer: the 50 latest issues", ours: 8.8 ms, theirs: 9.4 ms, ratio: 1.1× }
demo:
  count: 100,000
  source: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-docstore
---

<div class="home-warnings">

::: warning
opfs-lsm is still under heavy development.

We want it to be the building block for the best UX in web apps, and still ironing the fundamental details.

Still, storage is fault-tolerant and heavily tested, so if you want to play around, [feedback](https://github.com/gdorsi/opfs-lsm/issues) is very welcome!
:::

</div>

## Use cases

Pick what your app is built on. Each adapter keeps that library's API and stores its data in opfs-lsm.

<UseCases :cases="$frontmatter.fits">
<template v-slot:tanstack-db>

```sh
pnpm add @opfs-lsm/tanstack-db @opfs-lsm/docstore @opfs-lsm/kv
```

```ts
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";

const kv = await openDb({ name: "app" });
const store = await openDocStore(kv, schema);
const todos = createCollection(
  docstoreCollectionOptions({
    collection: store.collection("todos"),
  }),
);
```

</template>
<template v-slot:fate>

```sh
pnpm add @opfs-lsm/fate @opfs-lsm/kv @nkzw/fate
```

```ts
import { kvStorage } from "@opfs-lsm/fate";

const db = await openDb({ name: "app" });
const persistence = createPersistence({
  key: "acct:1",
  storage: kvStorage(db),
});
const client = createClient({ persistence, roots, transport, types });
```

</template>
<template v-slot:yjs>

```sh
pnpm add @opfs-lsm/yjs @opfs-lsm/kv
```

```ts
import { KvPersistence } from "@opfs-lsm/yjs";

const db = await openDb({ name: "notes" });
const doc = new Y.Doc();
const persistence = new KvPersistence(db, "note-1", doc);
await persistence.whenSynced;
```

</template>
<template v-slot:automerge>

```sh
pnpm add @opfs-lsm/automerge @opfs-lsm/kv
```

```ts
import { kvStorage } from "@opfs-lsm/automerge";

const db = await openDb({ name: "notes" });
const repo = new Repo({ storage: kvStorage(db) });
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
</UseCases>

## What kv gives you

<div class="home-features">
<div>

### Lightweight, with super-fast loads

18.8 kB gzip at import, and up to 4.8× faster cold loads with the Yjs adapter

```ts
// in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker and wasm load here
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

## Our benchmarks

<Benchmarks :charts="$frontmatter.bench" />

<div class="bench-foot">

Storage calls on an Apple M5 Max; the task tracker, SQLite and typing runs on an Apple M2 Pro, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>

## Under the hood

<div class="home-lede">

A write is one row in a write-ahead log, a list of recent writes kept in IndexedDB, and the other tabs of your app hear about it over a BroadcastChannel, a message channel between tabs. One SharedWorker, a background script that all those tabs share, then moves the log into sorted files in OPFS, the browser's private file system.

</div>

[How it works](../docs/how-it-works.md) · [Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

<Illustration name="hood" full />
