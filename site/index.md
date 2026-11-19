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
          - { measure: "Random writes, batches of 1,000", ours: 344k ops/s, theirs: 26.1k ops/s, ratio: 13× }
          - { measure: "Random point reads", ours: 557k ops/s, theirs: 16.6k ops/s, ratio: 33× }
          - { measure: "Reads of missing keys", ours: 1.34M ops/s, theirs: 17.2k ops/s, ratio: 78× }
          - { measure: "Full ordered scan", ours: 1.27M ops/s, theirs: 429k ops/s, ratio: 3.0× }
          - { measure: "Single put, awaited one at a time", ours: 8.39k ops/s, theirs: 9.19k ops/s, ratio: 0.91× ‡ }
          - { measure: "Opening the database in a fresh tab", ours: 5.01 ms, theirs: 0.321 ms, ratio: 0.064× }
      - title: Framework adapters
        versus: against each framework's IndexedDB option
        stores: [opfs-lsm, the IndexedDB option]
        setup: TanStack DB, y-indexeddb, automerge-repo and fate's own IndexedDB storage
        rows:
          - { measure: "TanStack DB: cold load of 91,000 rows", ours: 254 ms, theirs: 905 ms, ratio: 3.6× }
          - { measure: "TanStack DB: bulk insert, 100,000 rows", ours: 107k rows/s, theirs: 12.5k rows/s, ratio: 8.5× }
          - { measure: "TanStack DB: one row per transaction", ours: 4.15k rows/s, theirs: 4.87k rows/s, ratio: 0.85× }
          - { measure: "Yjs: cold load of 500 notes", ours: 9.69k notes/s, theirs: 1.88k notes/s, ratio: 5.2× }
          - { measure: "Yjs: editing trace, an update per keystroke", ours: 23.5k edits/s, theirs: 2.24k edits/s, ratio: 10× }
          - { measure: "Automerge: cold load of 500 notes", ours: 2.06k notes/s, theirs: 1.41k notes/s, ratio: 1.5× }
          - { measure: "Automerge: write 500 notes", ours: 649 notes/s, theirs: 612 notes/s, ratio: 1.1× }
          - { measure: "fate: cold load of 100 lists", ours: 3.38k records/s, theirs: 1.56k records/s, ratio: 2.2× }
      - title: Typing, then reopening
        versus: Yjs and Automerge on kv against their IndexedDB storage
        stores: [kv, the IndexedDB option]
        setup: kv settles by moving recent writes from its log into sorted files
        note: No frames dropped while typing, on any of the four. automerge-repo saves at most every 100 ms, so most Automerge keystrokes write nothing.
        rows:
          - { measure: "Yjs: one keystroke, with its persistence", ours: 0.256 ms, theirs: 0.204 ms, ratio: 0.80× }
          - { measure: "Yjs: reopening right after typing", ours: 14.1 ms, theirs: 8.44 ms, ratio: 0.60× }
          - { measure: "Yjs: reopening once kv has settled", ours: 14.1 ms, theirs: 8.51 ms, ratio: 0.60× }
          - { measure: "Automerge: one keystroke, with its persistence", ours: 0.561 ms, theirs: 0.539 ms, ratio: 0.96× ‡ }
          - { measure: "Automerge: reopening right after typing", ours: 63.3 ms, theirs: 58.1 ms, ratio: 0.92× }
          - { measure: "Automerge: reopening once kv has settled", ours: 64.4 ms, theirs: 58.5 ms, ratio: 0.91× }
  - title: Against SQLite on OPFS
    theirs: SQLite
    groups:
      - title: A task tracker
        versus: docstore against SQLite on OPFS
        stores: [docstore, SQLite on OPFS]
        setup: 20,000 issues, 42,000 comments, 120 people. Medians of 3 runs
        note: SQLite waits for each commit to be crash-safe before returning, its default. docstore returns sooner, with Chrome's relaxed durability.
        rows:
          - { measure: "Opening the store in a fresh tab", ours: 14.1 ms, theirs: 24.8 ms, ratio: 1.8× }
          - { measure: "Import, mean of 47 batches of up to 1,000 rows", ours: 14.9 ms, theirs: 21.9 ms, ratio: 1.5× }
          - { measure: "Sync, mean of 851 batches of about 50 changes", ours: 3.00 ms, theirs: 13.7 ms, ratio: 4.6× }
          - { measure: "Sprint close, 1,054 issues in one batch", ours: 55.9 ms, theirs: 92.1 ms, ratio: 1.6× }
          - { measure: "One edit", ours: 0.463 ms, theirs: 1.05 ms, ratio: 2.3× }
          - { measure: "Re-reading the 50 latest issues during the sync", ours: 0.60 ms, theirs: 0.56 ms, ratio: 0.93× }
      - title: Its screens, cold
        versus: the first call in a fresh tab
        stores: [docstore, SQLite on OPFS]
        setup: Cold, docstore is faster than SQLite on 7 of the 11 goals and slower on 3.
        note: Dexie, the third store in the full table, beats docstore at one edit, at opening the store and on 5 of the 11 cold screens.
        rows:
          - { measure: "Issues per status in a project", ours: 2.99 ms, theirs: 5.39 ms, ratio: 1.8× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 8.05 ms, theirs: 6.84 ms, ratio: 0.85× }
          - { measure: "The column a sprint close just emptied", ours: 5.00 ms, theirs: 5.82 ms, ratio: 1.2× }
          - { measure: "Rows at 90% of a project's list", ours: 9.48 ms, theirs: 6.01 ms, ratio: 0.63× }
          - { measure: "An issue with its comments and their authors", ours: 5.48 ms, theirs: 6.11 ms, ratio: 1.1× }
          - { measure: "First 50 open issues by priority, with counts", ours: 11.2 ms, theirs: 9.13 ms, ratio: 0.81× }
          - { measure: "First 50 open issues with a label", ours: 5.76 ms, theirs: 9.33 ms, ratio: 1.6× }
          - { measure: "First 50 open issues assigned to a person", ours: 7.81 ms, theirs: 7.66 ms, ratio: 0.98× }
          - { measure: "The 50 most recently updated issues", ours: 3.66 ms, theirs: 6.84 ms, ratio: 1.9× }
          - { measure: "Open issues per person, top 10", ours: 4.11 ms, theirs: 6.82 ms, ratio: 1.7× }
          - { measure: "First 20 issues whose title contains a word", ours: 7.02 ms, theirs: 7.44 ms, ratio: 1.1× }
      - title: Its screens, warm
        versus: the same call again
        stores: [docstore, SQLite on OPFS]
        setup: Warm, docstore answers 7 of the 11 goals fastest.
        rows:
          - { measure: "Issues per status in a project", ours: 0.178 ms, theirs: 0.165 ms, ratio: 0.93× }
          - { measure: "First 50 todo issues, with assignee and labels", ours: 0.349 ms, theirs: 0.528 ms, ratio: 1.5× }
          - { measure: "The column a sprint close just emptied", ours: 0.938 ms, theirs: 0.292 ms, ratio: 0.31× }
          - { measure: "Rows at 90% of a project's list", ours: 0.749 ms, theirs: 0.386 ms, ratio: 0.52× }
          - { measure: "An issue with its comments and their authors", ours: 0.123 ms, theirs: 0.267 ms, ratio: 2.2× }
          - { measure: "First 50 open issues by priority, with counts", ours: 0.677 ms, theirs: 1.48 ms, ratio: 2.2× }
          - { measure: "First 50 open issues with a label", ours: 0.201 ms, theirs: 1.58 ms, ratio: 7.8× }
          - { measure: "First 50 open issues assigned to a person", ours: 0.343 ms, theirs: 0.512 ms, ratio: 1.5× }
          - { measure: "The 50 most recently updated issues", ours: 0.480 ms, theirs: 0.762 ms, ratio: 1.6× }
          - { measure: "Open issues per person, top 10", ours: 0.450 ms, theirs: 0.379 ms, ratio: 0.84× }
          - { measure: "First 20 issues whose title contains a word", ours: 0.263 ms, theirs: 0.896 ms, ratio: 3.4× }
      - title: TanStack DB on demand
        versus: against its SQLite persistence
        stores: [opfs-lsm, SQLite]
        setup: 100,000 rows each; a query loads only the rows it asks for
        rows:
          - { measure: "Opening the collection in a fresh tab", ours: 7.97 ms, theirs: 48.7 ms, ratio: 6.1× }
          - { measure: "First query in a fresh tab", ours: 85.7 ms, theirs: 86.8 ms, ratio: 1.0× ‡ }
          - { measure: "Warm query of one owner, 6,250 rows", ours: 162k rows/s, theirs: 94.2k rows/s, ratio: 1.7× }
          - { measure: "10 rows by id", ours: 3.82k queries/s, theirs: 1.62k queries/s, ratio: 2.4× }
      - title: TanStack DB live queries
        versus: the task tracker, both on demand
        stores: [docstore, SQLite]
        setup: Four screens as live queries while the sync batches land
        note: "Frames dropped over 426 batches with the screens open: 0 on docstore, 210 on SQLite. SQLite waits for each commit to be crash-safe, its default; docstore doesn't."
        rows:
          - { measure: "Opening the collections in a fresh tab", ours: 7.85 ms, theirs: 56.1 ms, ratio: 7.1× }
          - { measure: "A sync batch, four screens open", ours: 4.28 ms, theirs: 109 ms, ratio: 25× }
          - { measure: "A sync batch, no screen open", ours: 1.31 ms, theirs: 25.9 ms, ratio: 20× }
          - { measure: "First answer: a project's todo column", ours: 22.8 ms, theirs: 39.9 ms, ratio: 1.8× }
          - { measure: "First answer: open issues with a label", ours: 9.91 ms, theirs: 10.5 ms, ratio: 1.1× ‡ }
          - { measure: "First answer: a person's open issues", ours: 6.62 ms, theirs: 8.00 ms, ratio: 1.2× }
          - { measure: "First answer: the 50 latest issues", ours: 8.87 ms, theirs: 9.85 ms, ratio: 1.1× }
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

Every run on an Apple M2 Pro, in headless Chrome 157.

[Every table](../docs/benchmarks.md) · [How we measure](../bench/README.md)

</div>
