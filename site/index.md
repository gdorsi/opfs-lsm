---
layout: home
title: opfs-lsm
hero:
  name: opfs-lsm
  text: A faster database for the browser
  tagline: A k/v store you can use to speed up your sync engine, without having to bloat your app
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/#quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
adapters:
  command: pnpm bench
  frameworks:
    - name: TanStack DB
      baseline: its IndexedDB adapter
      rows:
        - workload: Bulk insert
          indexeddb: 16.1k rows/s
          kv: 109k rows/s
          ratio: 6.8×
        - workload: Serial insert
          indexeddb: 3.2k rows/s
          kv: 2.5k rows/s
          ratio: 0.8×
    - name: Yjs
      baseline: y-indexeddb
      rows:
        - workload: Editing trace
          indexeddb: 1.6k edits/s
          kv: 30.4k edits/s
          ratio: 18×
        - workload: Cold load, 500 notes
          indexeddb: 2.8k notes/s
          kv: 9.8k notes/s
          ratio: 3.6×
    - name: Automerge
      baseline: automerge-repo IndexedDB
      rows:
        - workload: Write 500 notes
          indexeddb: 776 notes/s
          kv: 812 notes/s
          ratio: 1.0×
        - workload: Cold load, 500 notes
          indexeddb: 1.2k notes/s
          kv: 2.4k notes/s
          ratio: 2.0×
    - name: fate
      baseline: its IndexedDB persistence
      rows:
        - workload: Cold load, 100 lists
          indexeddb: 1.3k records/s
          kv: 3.7k records/s
          ratio: 2.9×
        - workload: Queue 300 mutations
          indexeddb: 231 ops/s
          kv: 274 ops/s
          ratio: 1.2×
size:
  main: 17.2 kB
  worker: 11.5 kB
  wasm: 16.3 kB
  lazy: 27.9 kB
demo:
  count: 100,000
---

## Try it with 100,000 issues

[LinearLite](../examples/linearlite) on kv, with no server · [What the timings measure](../examples/linearlite/DESIGN.md#the-build-with-no-server)

<HomeDemo />

## Faster than IndexedDB

[The adapter benchmarks](../README.md#benchmarks) · [How they are measured](../bench/README.md)

<Illustration name="adapters" full :data="$frontmatter.adapters" label="The adapter benchmarks, each opfs-lsm adapter against the IndexedDB option of its framework. TanStack DB: bulk insert 109k rows/s against 16.1k, 6.8× faster; serial insert 2.5k rows/s against 3.2k, 0.8× as fast. Yjs against y-indexeddb: editing trace 30.4k edits/s against 1.6k, 18× faster; cold load of 500 notes 9.8k notes/s against 2.8k, 3.6× faster. Automerge against automerge-repo's IndexedDB storage: writing 500 notes 812 notes/s against 776, about equal; cold load of 500 notes 2.4k notes/s against 1.2k, 2.0× faster. fate against its IndexedDB persistence: cold load of 100 lists 3.7k records/s against 1.3k, 2.9× faster; queueing 300 mutations 274 ops/s against 231, 1.2× faster." />

<div class="home-claim flip">
<div class="home-copy">

## Lightweight

17.2 kB are part of the critical path to load, and the rest is loaded lazily · [File by file](../README.md#bundle-size)

</div>
<Illustration name="bundle" :data="$frontmatter.size" label="A page imports kv and downloads 17.2 kB. When a click handler calls openDb, the SharedWorker chunk (11.5 kB) and the wasm engine (16.3 kB) load, 27.9 kB more." />
</div>

## One store under your stack

<div class="home-adapters">

- [TanStack DB](../packages/tanstack-db/README.md) Collections
- [Yjs](../packages/yjs/README.md) Documents
- [Automerge](../packages/automerge/README.md) Repo storage
- [fate](../packages/fate/README.md) Client persistence
- [docstore](../packages/docstore/README.md) JSON documents, in beta
- [kv API](../packages/kv/README.md) Your own layer

</div>

<div class="home-claim">
<div class="home-copy">

## Under the hood

[Engine design](../docs/design.md) · [How each promise is verified](../docs/verification.md) · [Browser support](../README.md#browser-support)

</div>
<Illustration name="stack" label="A tab puts a record, which becomes a row of the write-ahead log in IndexedDB: that row is the ack. The SharedWorker flushes the rows of the log into one SST file in OPFS and truncates the log. The tab reads the SST files itself." />
</div>
