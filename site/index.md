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
        setup: Medians of 5 runs, 100,000 entries
        rows:
          - { measure: "Random writes, batches of 1,000", ours: 392k ops/s, theirs: 22.7k ops/s, ratio: 17× }
          - { measure: "Random point reads", ours: 450k ops/s, theirs: 15.2k ops/s, ratio: 30× }
          - { measure: "Reads of missing keys", ours: 1.02M ops/s, theirs: 17.3k ops/s, ratio: 59× }
          - { measure: "Full ordered scan", ours: 1.88M ops/s, theirs: 384k ops/s, ratio: 4.9× }
          - { measure: "Single put, awaited one at a time", ours: 7.63k ops/s, theirs: 9.05k ops/s, ratio: 0.84× ‡ }
          - { measure: "Opening the database in a fresh tab", ours: 5.44 ms, theirs: 0.317 ms, ratio: 0.058× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 299 ms, theirs: 1.02 s, ratio: 3.4× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 105k rows/s, theirs: 9.80k rows/s, ratio: 11× }
          - { measure: "TanStack DB: one row per transaction", ours: 5.04k rows/s, theirs: 3.30k rows/s, ratio: 1.5× ‡ }
          - { measure: "Yjs: cold load of 500 notes", ours: 8.78k notes/s, theirs: 1.90k notes/s, ratio: 4.6× }
          - { measure: "Yjs: editing trace in one burst, no yield", ours: 18.5k edits/s, theirs: 2.13k edits/s, ratio: 8.7× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.02k notes/s, theirs: 1.33k notes/s, ratio: 1.5× }
          - { measure: "Automerge: write 500 notes", ours: 668 notes/s, theirs: 627 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 3.14k records/s, theirs: 1.18k records/s, ratio: 2.7× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.156 ms, theirs: 0.130 ms, ratio: 0.83× ‡ }
          - { measure: "Yjs: reopening right after typing", ours: 16.5 ms, theirs: 8.36 ms, ratio: 0.50× }
          - { measure: "Yjs: reopening once kv has settled", ours: 16.5 ms, theirs: 8.20 ms, ratio: 0.50× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.521 ms, theirs: 0.288 ms, ratio: 0.55× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 63.6 ms, theirs: 59.0 ms, ratio: 0.93× }
          - { measure: "Automerge: reopening once kv has settled", ours: 66.3 ms, theirs: 58.8 ms, ratio: 0.89× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 14.8 ms, theirs: 27.1 ms, ratio: 1.8× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 13.9 ms, theirs: 21.2 ms, ratio: 1.5× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.77 ms, theirs: 13.3 ms, ratio: 4.8× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 46.7 ms, theirs: 64.4 ms, ratio: 1.4× }
          - { measure: "One edit", ours: 0.337 ms, theirs: 1.17 ms, ratio: 3.5× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.577 ms, theirs: 0.584 ms, ratio: 1.0× ‡ }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 2 of the 11 goals and slower on 6.
        note: Dexie, the third store in the full table, beats docstore at opening the store and on 7 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 4.93 ms, theirs: 5.34 ms, ratio: 1.1× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 10.0 ms, theirs: 7.03 ms, ratio: 0.70× }
          - { measure: "The column a sprint close just emptied", ours: 6.14 ms, theirs: 5.90 ms, ratio: 0.96× ‡ }
          - { measure: "Rows at 90% of a project's list", ours: 11.0 ms, theirs: 6.22 ms, ratio: 0.56× }
          - { measure: "An issue with its comments and their authors", ours: 6.82 ms, theirs: 6.19 ms, ratio: 0.91× }
          - { measure: "First 50 open issues by priority, with counts", ours: 14.9 ms, theirs: 7.25 ms, ratio: 0.49× }
          - { measure: "First 50 open issues with a label", ours: 12.2 ms, theirs: 13.3 ms, ratio: 1.1× ‡ }
          - { measure: "First 50 open issues assigned to a person", ours: 12.6 ms, theirs: 7.74 ms, ratio: 0.62× }
          - { measure: "The 50 most recently updated issues", ours: 5.15 ms, theirs: 6.74 ms, ratio: 1.3× }
          - { measure: "Open issues per person, top 10", ours: 5.88 ms, theirs: 6.98 ms, ratio: 1.2× }
          - { measure: "First 20 issues whose title contains a word", ours: 8.07 ms, theirs: 7.03 ms, ratio: 0.87× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 5 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.192 ms, theirs: 0.196 ms, ratio: 1.0× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.375 ms, theirs: 0.543 ms, ratio: 1.4× }
          - { measure: "The column a sprint close just emptied", ours: 0.772 ms, theirs: 0.312 ms, ratio: 0.40× }
          - { measure: "Rows at 90% of a project's list", ours: 0.414 ms, theirs: 0.368 ms, ratio: 0.89× }
          - { measure: "An issue with its comments and their authors", ours: 0.134 ms, theirs: 0.294 ms, ratio: 2.2× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.832 ms, theirs: 0.422 ms, ratio: 0.51× }
          - { measure: "First 50 open issues with a label", ours: 0.567 ms, theirs: 4.21 ms, ratio: 7.4× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.622 ms, theirs: 0.574 ms, ratio: 0.92× ‡ }
          - { measure: "The 50 most recently updated issues", ours: 0.542 ms, theirs: 0.787 ms, ratio: 1.5× }
          - { measure: "Open issues per person, top 10", ours: 0.438 ms, theirs: 0.367 ms, ratio: 0.84× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.283 ms, theirs: 0.640 ms, ratio: 2.3× }
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

Runs in headless Chrome 157 on an Apple M2 Pro.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
