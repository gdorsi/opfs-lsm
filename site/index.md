---
layout: home
title: opfs-lsm
intro:
  title: Fast local storage for your web app
  tagline: This issue tracker keeps 100,000 issues in your browser. There is no server.
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
size:
  main: 18.8 kB
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
demo:
  count: 100,000
  source: https://github.com/gdorsi/opfs-lsm/tree/main/examples/linearlite-docstore
---

<div class="home-warnings">

::: warning
opfs-lsm is still under heavy development.

We want it to be the building block for the best UX in web apps, and still ironing the fundamental details.

Still, storage is fault-tolerant and heavily tested, so if you want to play around, feedback is very welcome!
:::

</div>

<div class="home-features">
<div>

### Lightweight, with super-fast loads

18.8 kB at import, and up to 4.8× faster cold loads with the Yjs adapter

```ts
// 18.8 kB gzip in your main bundle
import { openDb } from "@opfs-lsm/kv";
// the SharedWorker and wasm load here
const db = await openDb({ name: "app" });
```

</div>
<div>

### Use it with your framework

Adapters for TanStack DB, Yjs, Automerge and fate

```ts
const todos = createCollection(
  docstoreCollectionOptions({
    collection: store.collection("todos"),
  }),
);
```

</div>
<div>

### A low-level API for your own adapter

A key-value storage you can use to build your own DB

```ts
await db.put(key, bytes);
const saved = await db.get(key);
for await (const { value } of db.range({ limit: 50 })) {
  // ...
}
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

[TanStack DB](../packages/tanstack-db/README.md) · [fate](../packages/fate/README.md) · [Yjs](../packages/yjs/README.md) · [Automerge](../packages/automerge/README.md) · [docstore](../packages/docstore/README.md) · [kv API](../packages/kv/README.md)

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

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../docs/browser-support.md)

</div>
<Illustration name="stack" />
</div>
