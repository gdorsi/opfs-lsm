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
        setup: Medians of 10 or 21 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 480k ops/s, theirs: 40.8k ops/s, ratio: 12× }
          - { measure: "Random point reads", ours: 738k ops/s, theirs: 21.2k ops/s, ratio: 35× }
          - { measure: "Reads of missing keys", ours: 1.87M ops/s, theirs: 24.9k ops/s, ratio: 75× }
          - { measure: "Full ordered scan", ours: 1.75M ops/s, theirs: 676k ops/s, ratio: 2.6× }
          - { measure: "Single put, awaited one at a time", ours: 13.3k ops/s, theirs: 14.7k ops/s, ratio: 0.91× }
          - { measure: "Opening the database in a fresh tab", ours: 3.91 ms, theirs: 0.275 ms, ratio: 0.07× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 172 ms, theirs: 661 ms, ratio: 3.8× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 149k rows/s, theirs: 19.2k rows/s, ratio: 7.8× }
          - { measure: "TanStack DB: one row per transaction", ours: 6.10k rows/s, theirs: 7.07k rows/s, ratio: 0.86× }
          - { measure: "Yjs: cold load of 500 notes", ours: 13.0k notes/s, theirs: 2.93k notes/s, ratio: 4.5× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 34.7k edits/s, theirs: 1.98k edits/s, ratio: 17× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.73k notes/s, theirs: 1.95k notes/s, ratio: 1.4× }
          - { measure: "Automerge: write 500 notes", ours: 902 notes/s, theirs: 851 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 4.01k records/s, theirs: 2.26k records/s, ratio: 1.8× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.164 ms, theirs: 0.148 ms, ratio: 0.90× ‡ }
          - { measure: "Yjs: reopening right after typing", ours: 10.6 ms, theirs: 6.46 ms, ratio: 0.61× }
          - { measure: "Yjs: reopening once kv has settled", ours: 10.9 ms, theirs: 6.36 ms, ratio: 0.58× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.364 ms, theirs: 0.364 ms, ratio: 1.0× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 46.8 ms, theirs: 43.8 ms, ratio: 0.94× }
          - { measure: "Automerge: reopening once kv has settled", ours: 48.4 ms, theirs: 43.8 ms, ratio: 0.91× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 11.0 ms, theirs: 21.0 ms, ratio: 1.9× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 13.1 ms, theirs: 19.7 ms, ratio: 1.5× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.50 ms, theirs: 12.5 ms, ratio: 5.0× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 37.7 ms, theirs: 71.7 ms, ratio: 1.9× }
          - { measure: "One edit", ours: 0.358 ms, theirs: 3.37 ms, ratio: 9.4× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.473 ms, theirs: 0.470 ms, ratio: 1.0× ‡ }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 4.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on 5 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 2.62 ms, theirs: 4.05 ms, ratio: 1.5× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 6.18 ms, theirs: 5.20 ms, ratio: 0.84× }
          - { measure: "The column a sprint close just emptied", ours: 3.98 ms, theirs: 4.41 ms, ratio: 1.1× ‡ }
          - { measure: "Rows at 90% of a project's list", ours: 7.32 ms, theirs: 4.56 ms, ratio: 0.62× }
          - { measure: "An issue with its comments and their authors", ours: 4.65 ms, theirs: 4.55 ms, ratio: 0.98× ‡ }
          - { measure: "First 50 open issues by priority, with counts", ours: 9.05 ms, theirs: 7.09 ms, ratio: 0.78× }
          - { measure: "First 50 open issues with a label", ours: 4.84 ms, theirs: 7.12 ms, ratio: 1.5× }
          - { measure: "First 50 open issues assigned to a person", ours: 6.55 ms, theirs: 5.92 ms, ratio: 0.90× }
          - { measure: "The 50 most recently updated issues", ours: 3.42 ms, theirs: 4.97 ms, ratio: 1.5× }
          - { measure: "Open issues per person, top 10", ours: 3.34 ms, theirs: 5.11 ms, ratio: 1.5× }
          - { measure: "First 20 issues whose title contains a word", ours: 5.60 ms, theirs: 5.70 ms, ratio: 1.0× ‡ }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.128 ms, theirs: 0.137 ms, ratio: 1.1× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.266 ms, theirs: 0.439 ms, ratio: 1.7× }
          - { measure: "The column a sprint close just emptied", ours: 0.685 ms, theirs: 0.207 ms, ratio: 0.30× }
          - { measure: "Rows at 90% of a project's list", ours: 0.537 ms, theirs: 0.286 ms, ratio: 0.53× }
          - { measure: "An issue with its comments and their authors", ours: 0.0850 ms, theirs: 0.224 ms, ratio: 2.6× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.533 ms, theirs: 1.13 ms, ratio: 2.1× }
          - { measure: "First 50 open issues with a label", ours: 0.142 ms, theirs: 1.23 ms, ratio: 8.7× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.271 ms, theirs: 0.406 ms, ratio: 1.5× }
          - { measure: "The 50 most recently updated issues", ours: 0.392 ms, theirs: 0.638 ms, ratio: 1.6× }
          - { measure: "Open issues per person, top 10", ours: 0.320 ms, theirs: 0.315 ms, ratio: 0.99× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.185 ms, theirs: 0.730 ms, ratio: 4.0× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 6.89 ms, theirs: 41.6 ms, ratio: 6.0× }
          - { measure: "First query in a fresh tab", ours: 60.6 ms, theirs: 63.0 ms, ratio: 1.0× }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 228k rows/s, theirs: 128k rows/s, ratio: 1.8× }
          - { measure: "10 rows by id", ours: 5.28k queries/s, theirs: 2.11k queries/s, ratio: 2.5× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 0 on docstore, 77 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 8.69 ms, theirs: 49.6 ms, ratio: 5.7× }
          - { measure: "A sync batch, four screens open", ours: 3.33 ms, theirs: 82.4 ms, ratio: 25× }
          - { measure: "A sync batch, no screen open", ours: 1.04 ms, theirs: 22.3 ms, ratio: 22× }
          - { measure: "First answer: a project's todo column", ours: 17.6 ms, theirs: 30.4 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 7.04 ms, theirs: 7.84 ms, ratio: 1.1× ‡ }
          - { measure: "First answer: a person's open issues", ours: 4.34 ms, theirs: 6.52 ms, ratio: 1.5× }
          - { measure: "First answer: the 50 latest issues", ours: 6.55 ms, theirs: 7.76 ms, ratio: 1.2× }
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
// 20.2 kB gzip in your main bundle
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

Every run on an Apple M5 Max, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
