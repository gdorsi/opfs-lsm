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
          - { measure: "Random writes, batches of 1,000", ours: 487k ops/s, theirs: 42.2k ops/s, ratio: 12× }
          - { measure: "Random point reads", ours: 734k ops/s, theirs: 20.1k ops/s, ratio: 37× }
          - { measure: "Reads of missing keys", ours: 1.91M ops/s, theirs: 22.9k ops/s, ratio: 83× }
          - { measure: "Full ordered scan", ours: 1.79M ops/s, theirs: 674k ops/s, ratio: 2.7× }
          - { measure: "Single put, awaited one at a time", ours: 13.6k ops/s, theirs: 14.4k ops/s, ratio: 0.94× ‡ }
          - { measure: "Opening the database in a fresh tab", ours: 3.68 ms, theirs: 0.545 ms, ratio: 0.15× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        note: The Automerge write, 1.0×, is even.
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 167 ms, theirs: 664 ms, ratio: 4.0× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 141k rows/s, theirs: 19.4k rows/s, ratio: 7.3× }
          - { measure: "TanStack DB: one row per transaction", ours: 5.94k rows/s, theirs: 7.50k rows/s, ratio: 0.79× }
          - { measure: "Yjs: cold load of 500 notes", ours: 13.2k notes/s, theirs: 2.81k notes/s, ratio: 4.7× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 34.8k edits/s, theirs: 1.89k edits/s, ratio: 18× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.81k notes/s, theirs: 1.97k notes/s, ratio: 1.4× }
          - { measure: "Automerge: write 500 notes", ours: 910 notes/s, theirs: 873 notes/s, ratio: 1.0× ‡ }
          - { measure: "fate: cold load of 100 lists", ours: 4.24k records/s, theirs: 2.12k records/s, ratio: 2.0× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.147 ms, theirs: 0.118 ms, ratio: 0.80× ‡ }
          - { measure: "Yjs: reopening right after typing", ours: 10.8 ms, theirs: 6.78 ms, ratio: 0.63× ‡ }
          - { measure: "Yjs: reopening once kv has settled", ours: 11.5 ms, theirs: 6.56 ms, ratio: 0.57× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.289 ms, theirs: 0.276 ms, ratio: 0.96× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 46.6 ms, theirs: 42.8 ms, ratio: 0.92× ‡ }
          - { measure: "Automerge: reopening once kv has settled", ours: 47.8 ms, theirs: 42.8 ms, ratio: 0.90× ‡ }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 3 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 10.6 ms, theirs: 24.8 ms, ratio: 2.3× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 14.4 ms, theirs: 17.4 ms, ratio: 1.2× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 2.71 ms, theirs: 14.0 ms, ratio: 5.2× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 36.7 ms, theirs: 74.3 ms, ratio: 2.0× }
          - { measure: "One edit", ours: 0.348 ms, theirs: 2.80 ms, ratio: 8.1× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.55 ms, theirs: 0.51 ms, ratio: 0.92× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 6 of the 11 goals and slower on 2.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on 5 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 2.55 ms, theirs: 4.10 ms, ratio: 1.6× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 6.04 ms, theirs: 5.22 ms, ratio: 0.86× ‡ }
          - { measure: "The column a sprint close just emptied", ours: 3.91 ms, theirs: 4.57 ms, ratio: 1.2× }
          - { measure: "Rows at 90% of a project's list", ours: 7.12 ms, theirs: 4.63 ms, ratio: 0.65× }
          - { measure: "An issue with its comments and their authors", ours: 4.51 ms, theirs: 4.86 ms, ratio: 1.1× ‡ }
          - { measure: "First 50 open issues by priority, with counts", ours: 8.45 ms, theirs: 7.12 ms, ratio: 0.84× }
          - { measure: "First 50 open issues with a label", ours: 4.64 ms, theirs: 7.48 ms, ratio: 1.6× }
          - { measure: "First 50 open issues assigned to a person", ours: 6.30 ms, theirs: 5.94 ms, ratio: 0.94× ‡ }
          - { measure: "The 50 most recently updated issues", ours: 3.20 ms, theirs: 5.39 ms, ratio: 1.7× }
          - { measure: "Open issues per person, top 10", ours: 3.35 ms, theirs: 5.63 ms, ratio: 1.7× }
          - { measure: "First 20 issues whose title contains a word", ours: 5.39 ms, theirs: 6.13 ms, ratio: 1.1× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.138 ms, theirs: 0.144 ms, ratio: 1.0× ‡ }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.271 ms, theirs: 0.423 ms, ratio: 1.6× }
          - { measure: "The column a sprint close just emptied", ours: 0.857 ms, theirs: 0.230 ms, ratio: 0.27× }
          - { measure: "Rows at 90% of a project's list", ours: 0.649 ms, theirs: 0.302 ms, ratio: 0.46× }
          - { measure: "An issue with its comments and their authors", ours: 0.0963 ms, theirs: 0.230 ms, ratio: 2.4× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.535 ms, theirs: 1.20 ms, ratio: 2.2× }
          - { measure: "First 50 open issues with a label", ours: 0.136 ms, theirs: 1.28 ms, ratio: 9.4× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.239 ms, theirs: 0.424 ms, ratio: 1.8× }
          - { measure: "The 50 most recently updated issues", ours: 0.370 ms, theirs: 0.693 ms, ratio: 1.9× }
          - { measure: "Open issues per person, top 10", ours: 0.438 ms, theirs: 0.331 ms, ratio: 0.76× ‡ }
          - { measure: "First 20 issues whose title contains a word", ours: 0.185 ms, theirs: 0.708 ms, ratio: 3.8× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 6.60 ms, theirs: 42.1 ms, ratio: 6.4× }
          - { measure: "First query in a fresh tab", ours: 63.8 ms, theirs: 66.0 ms, ratio: 1.0× ‡ }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 221k rows/s, theirs: 124k rows/s, ratio: 1.8× }
          - { measure: "10 rows by id", ours: 4.99k queries/s, theirs: 2.00k queries/s, ratio: 2.5× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 0 on docstore, 107 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 9.12 ms, theirs: 51.6 ms, ratio: 5.7× }
          - { measure: "A sync batch, four screens open", ours: 3.89 ms, theirs: 93.5 ms, ratio: 24× }
          - { measure: "A sync batch, no screen open", ours: 1.23 ms, theirs: 26.2 ms, ratio: 21× }
          - { measure: "First answer: a project's todo column", ours: 17.5 ms, theirs: 32.1 ms, ratio: 1.8× }
          - { measure: "First answer: open issues with a label", ours: 7.75 ms, theirs: 8.64 ms, ratio: 1.1× ‡ }
          - { measure: "First answer: a person's open issues", ours: 4.67 ms, theirs: 6.82 ms, ratio: 1.5× }
          - { measure: "First answer: the 50 latest issues", ours: 7.35 ms, theirs: 7.79 ms, ratio: 1.1× ‡ }
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

[How it works](../docs/how-it-works.md) · [What kv promises](../docs/how-it-works.md#consistent-not-durable) · [Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

## Our benchmarks

<Benchmarks :charts="$frontmatter.bench" />

<div class="bench-foot">

Every run on an Apple M5 Max, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
