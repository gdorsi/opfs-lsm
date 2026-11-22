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
          - { measure: "Random writes, batches of 1,000", ours: 401k ops/s, theirs: 26.8k ops/s, ratio: 15× }
          - { measure: "Random point reads", ours: 447k ops/s, theirs: 16.9k ops/s, ratio: 26× }
          - { measure: "Reads of missing keys", ours: 994k ops/s, theirs: 16.5k ops/s, ratio: 60× }
          - { measure: "Full ordered scan", ours: 1.86M ops/s, theirs: 444k ops/s, ratio: 4.2× }
          - { measure: "Single put, awaited one at a time", ours: 7.71k ops/s, theirs: 9.03k ops/s, ratio: 0.85× }
          - { measure: "Opening the database in a fresh tab", ours: 5.13 ms, theirs: 0.326 ms, ratio: 0.064× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 247 ms, theirs: 915 ms, ratio: 3.7× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 112k rows/s, theirs: 12.9k rows/s, ratio: 8.7× }
          - { measure: "TanStack DB: one row per transaction", ours: 6.76k rows/s, theirs: 4.93k rows/s, ratio: 1.4× }
          - { measure: "Yjs: cold load of 500 notes", ours: 10.7k notes/s, theirs: 2.72k notes/s, ratio: 3.9× }
          - { measure: "Yjs: editing trace in one burst, no yield", ours: 23.8k edits/s, theirs: 2.28k edits/s, ratio: 10× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.03k notes/s, theirs: 1.43k notes/s, ratio: 1.4× }
          - { measure: "Automerge: write 500 notes", ours: 673 notes/s, theirs: 634 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 3.37k records/s, theirs: 1.56k records/s, ratio: 2.2× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.321 ms, theirs: 0.230 ms, ratio: 0.72× }
          - { measure: "Yjs: reopening right after typing", ours: 14.4 ms, theirs: 8.25 ms, ratio: 0.57× }
          - { measure: "Yjs: reopening once kv has settled", ours: 14.5 ms, theirs: 8.28 ms, ratio: 0.57× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.607 ms, theirs: 0.584 ms, ratio: 0.96× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 62.9 ms, theirs: 57.7 ms, ratio: 0.92× }
          - { measure: "Automerge: reopening once kv has settled", ours: 63.8 ms, theirs: 58.0 ms, ratio: 0.91× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 14.5 ms, theirs: 27.8 ms, ratio: 1.9× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 13.8 ms, theirs: 21.1 ms, ratio: 1.5× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.72 ms, theirs: 13.0 ms, ratio: 4.8× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 53.4 ms, theirs: 65.0 ms, ratio: 1.2× }
          - { measure: "One edit", ours: 0.332 ms, theirs: 1.99 ms, ratio: 6.0× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.550 ms, theirs: 0.556 ms, ratio: 1.0× ‡ }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 4.
        note: Dexie, the third store in the full table, beats docstore at opening the store and on 8 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 4.73 ms, theirs: 5.43 ms, ratio: 1.1× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 9.10 ms, theirs: 7.10 ms, ratio: 0.78× }
          - { measure: "The column a sprint close just emptied", ours: 5.66 ms, theirs: 6.03 ms, ratio: 1.1× ‡ }
          - { measure: "Rows at 90% of a project's list", ours: 10.9 ms, theirs: 6.14 ms, ratio: 0.56× }
          - { measure: "An issue with its comments and their authors", ours: 7.06 ms, theirs: 6.16 ms, ratio: 0.87× ‡ }
          - { measure: "First 50 open issues by priority, with counts", ours: 13.9 ms, theirs: 7.23 ms, ratio: 0.52× }
          - { measure: "First 50 open issues with a label", ours: 10.5 ms, theirs: 13.1 ms, ratio: 1.2× }
          - { measure: "First 50 open issues assigned to a person", ours: 10.2 ms, theirs: 7.76 ms, ratio: 0.76× }
          - { measure: "The 50 most recently updated issues", ours: 4.77 ms, theirs: 6.84 ms, ratio: 1.4× }
          - { measure: "Open issues per person, top 10", ours: 5.79 ms, theirs: 7.01 ms, ratio: 1.2× }
          - { measure: "First 20 issues whose title contains a word", ours: 8.19 ms, theirs: 7.04 ms, ratio: 0.86× ‡ }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 6 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.172 ms, theirs: 0.166 ms, ratio: 0.96× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.370 ms, theirs: 0.532 ms, ratio: 1.4× }
          - { measure: "The column a sprint close just emptied", ours: 0.740 ms, theirs: 0.265 ms, ratio: 0.36× }
          - { measure: "Rows at 90% of a project's list", ours: 0.415 ms, theirs: 0.360 ms, ratio: 0.87× }
          - { measure: "An issue with its comments and their authors", ours: 0.116 ms, theirs: 0.259 ms, ratio: 2.2× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.686 ms, theirs: 0.419 ms, ratio: 0.61× }
          - { measure: "First 50 open issues with a label", ours: 0.445 ms, theirs: 4.03 ms, ratio: 9.1× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.452 ms, theirs: 0.543 ms, ratio: 1.2× }
          - { measure: "The 50 most recently updated issues", ours: 0.542 ms, theirs: 0.792 ms, ratio: 1.5× }
          - { measure: "Open issues per person, top 10", ours: 0.425 ms, theirs: 0.360 ms, ratio: 0.85× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.285 ms, theirs: 0.670 ms, ratio: 2.4× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 7.70 ms, theirs: 48.9 ms, ratio: 6.4× }
          - { measure: "First query in a fresh tab", ours: 77.8 ms, theirs: 88.3 ms, ratio: 1.1× }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 183k rows/s, theirs: 97.2k rows/s, ratio: 1.9× }
          - { measure: "10 rows by id", ours: 3.87k queries/s, theirs: 1.54k queries/s, ratio: 2.5× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 27 on docstore, 210 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 8.51 ms, theirs: 58.1 ms, ratio: 6.8× }
          - { measure: "A sync batch, four screens open", ours: 5.92 ms, theirs: 119 ms, ratio: 20× }
          - { measure: "A sync batch, no screen open", ours: 1.12 ms, theirs: 26.1 ms, ratio: 23× }
          - { measure: "First answer: a project's todo column", ours: 23.2 ms, theirs: 39.4 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 26.1 ms, theirs: 34.8 ms, ratio: 1.3× }
          - { measure: "First answer: a person's open issues", ours: 5.75 ms, theirs: 8.25 ms, ratio: 1.4× }
          - { measure: "First answer: the 50 latest issues", ours: 9.41 ms, theirs: 10.2 ms, ratio: 1.1× }
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
// 19.5 kB gzip in your main bundle
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
