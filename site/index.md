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
          - { measure: "Random writes, batches of 1,000", ours: 637k ops/s, theirs: 42.9k ops/s, ratio: 15× }
          - { measure: "Random point reads", ours: 1.06M ops/s, theirs: 20.5k ops/s, ratio: 52× }
          - { measure: "Reads of missing keys", ours: 3.53M ops/s, theirs: 23.7k ops/s, ratio: 150× }
          - { measure: "Full ordered scan", ours: 3.07M ops/s, theirs: 702k ops/s, ratio: 4.4× }
          - { measure: "Single put, awaited one at a time", ours: 12.2k ops/s, theirs: 14.1k ops/s, ratio: 0.87× ‡ }
          - { measure: "Opening the database in a fresh tab", ours: 3.77 ms, theirs: 0.269 ms, ratio: 0.071× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 149 ms, theirs: 637 ms, ratio: 4.3× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 162k rows/s, theirs: 21.0k rows/s, ratio: 7.7× }
          - { measure: "TanStack DB: one row per transaction", ours: 6.10k rows/s, theirs: 7.61k rows/s, ratio: 0.80× }
          - { measure: "Yjs: cold load of 500 notes", ours: 15.1k notes/s, theirs: 5.42k notes/s, ratio: 2.8× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 35.9k edits/s, theirs: 2.23k edits/s, ratio: 16× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.71k notes/s, theirs: 1.84k notes/s, ratio: 1.5× }
          - { measure: "Automerge: write 500 notes", ours: 948 notes/s, theirs: 874 notes/s, ratio: 1.1× ‡ }
          - { measure: "fate: cold load of 100 lists", ours: 4.25k records/s, theirs: 2.19k records/s, ratio: 1.9× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.202 ms, theirs: 0.172 ms, ratio: 0.85× ‡ }
          - { measure: "Yjs: reopening right after typing", ours: 10.5 ms, theirs: 6.41 ms, ratio: 0.61× }
          - { measure: "Yjs: reopening once kv has settled", ours: 10.6 ms, theirs: 6.29 ms, ratio: 0.60× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.406 ms, theirs: 0.424 ms, ratio: 1.0× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 46.0 ms, theirs: 43.8 ms, ratio: 0.95× }
          - { measure: "Automerge: reopening once kv has settled", ours: 47.1 ms, theirs: 43.7 ms, ratio: 0.93× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 5 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 11.4 ms, theirs: 23.0 ms, ratio: 2.0× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 11.2 ms, theirs: 17.6 ms, ratio: 1.6× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.29 ms, theirs: 12.0 ms, ratio: 5.3× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 37.2 ms, theirs: 70.5 ms, ratio: 1.9× }
          - { measure: "One edit", ours: 0.339 ms, theirs: 2.81 ms, ratio: 8.3× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.462 ms, theirs: 0.447 ms, ratio: 0.97× ‡ }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 5.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on 6 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 2.44 ms, theirs: 3.87 ms, ratio: 1.6× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 6.08 ms, theirs: 5.00 ms, ratio: 0.82× }
          - { measure: "The column a sprint close just emptied", ours: 3.90 ms, theirs: 4.37 ms, ratio: 1.1× ‡ }
          - { measure: "Rows at 90% of a project's list", ours: 6.97 ms, theirs: 4.42 ms, ratio: 0.63× }
          - { measure: "An issue with its comments and their authors", ours: 4.53 ms, theirs: 4.49 ms, ratio: 0.99× ‡ }
          - { measure: "First 50 open issues by priority, with counts", ours: 9.04 ms, theirs: 6.72 ms, ratio: 0.74× }
          - { measure: "First 50 open issues with a label", ours: 7.42 ms, theirs: 9.38 ms, ratio: 1.3× }
          - { measure: "First 50 open issues assigned to a person", ours: 7.53 ms, theirs: 6.15 ms, ratio: 0.82× }
          - { measure: "The 50 most recently updated issues", ours: 3.00 ms, theirs: 4.95 ms, ratio: 1.7× }
          - { measure: "Open issues per person, top 10", ours: 3.31 ms, theirs: 4.96 ms, ratio: 1.5× }
          - { measure: "First 20 issues whose title contains a word", ours: 5.59 ms, theirs: 4.95 ms, ratio: 0.89× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 8 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.108 ms, theirs: 0.130 ms, ratio: 1.2× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.241 ms, theirs: 0.400 ms, ratio: 1.7× }
          - { measure: "The column a sprint close just emptied", ours: 0.547 ms, theirs: 0.195 ms, ratio: 0.36× }
          - { measure: "Rows at 90% of a project's list", ours: 0.276 ms, theirs: 0.270 ms, ratio: 0.98× ‡ }
          - { measure: "An issue with its comments and their authors", ours: 0.0727 ms, theirs: 0.205 ms, ratio: 2.8× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.466 ms, theirs: 1.07 ms, ratio: 2.3× }
          - { measure: "First 50 open issues with a label", ours: 0.363 ms, theirs: 2.72 ms, ratio: 7.5× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.376 ms, theirs: 0.752 ms, ratio: 2.0× }
          - { measure: "The 50 most recently updated issues", ours: 0.430 ms, theirs: 0.570 ms, ratio: 1.3× }
          - { measure: "Open issues per person, top 10", ours: 0.308 ms, theirs: 0.276 ms, ratio: 0.90× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.169 ms, theirs: 0.497 ms, ratio: 2.9× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 6.39 ms, theirs: 38.4 ms, ratio: 6.0× }
          - { measure: "First query in a fresh tab", ours: 56.3 ms, theirs: 60.1 ms, ratio: 1.1× }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 261k rows/s, theirs: 141k rows/s, ratio: 1.8× }
          - { measure: "10 rows by id", ours: 5.75k queries/s, theirs: 2.16k queries/s, ratio: 2.7× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 16 on docstore, 60 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 6.73 ms, theirs: 54.3 ms, ratio: 8.1× }
          - { measure: "A sync batch, four screens open", ours: 4.33 ms, theirs: 85.5 ms, ratio: 20× }
          - { measure: "A sync batch, no screen open", ours: 0.959 ms, theirs: 20.7 ms, ratio: 22× }
          - { measure: "First answer: a project's todo column", ours: 17.0 ms, theirs: 29.2 ms, ratio: 1.7× }
          - { measure: "First answer: open issues with a label", ours: 20.0 ms, theirs: 24.5 ms, ratio: 1.2× }
          - { measure: "First answer: a person's open issues", ours: 4.14 ms, theirs: 6.02 ms, ratio: 1.5× }
          - { measure: "First answer: the 50 latest issues", ours: 6.64 ms, theirs: 7.38 ms, ratio: 1.1× }
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
// 19.9 kB gzip in your main bundle
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

Runs on an Apple M5 Max, the task tracker on an Apple M2 Pro, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
