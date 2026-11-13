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
bench:
  command: pnpm bench
  rows:
    - workload: Random point reads
      indexeddb: 14.3k ops/s
      kv: 341k ops/s
      ratio: 24×
    - workload: TanStack DB, bulk insert
      indexeddb: 11k rows/s
      kv: 88k rows/s
    - workload: Single put, awaited one at a time
      indexeddb: 4.0k ops/s
      kv: 3.3k ops/s
      ratio: 0.8×
size:
  main: 17.1 kB
  worker: 11.5 kB
  wasm: 16.3 kB
  lazy: 27.8 kB
demo:
  count: 100,000
---

## Try it with 100,000 issues

[LinearLite](../examples/linearlite) on kv, with no server · [What the timings measure](../examples/linearlite/DESIGN.md#the-build-with-no-server)

<HomeDemo />

<div class="home-claim">
<div class="home-copy">

## Faster than IndexedDB

[All eight workloads](../README.md#benchmarks) · [How they are measured](../bench/README.md)

</div>
<Illustration name="bench" :data="$frontmatter.bench" label="The kv benchmarks run, one workload after the other. Random point reads: IndexedDB 14.3k ops/s, kv 341k ops/s, 24× faster. TanStack DB, bulk insert: its IndexedDB adapter 11k rows/s, kv 88k rows/s. Single put, awaited one at a time: IndexedDB 4.0k ops/s, kv 3.3k ops/s, 0.8× as fast." />
</div>

<div class="home-claim flip">
<div class="home-copy">

## Lightweight

17.1 kB are part of the critical path to load, and the rest is loaded lazily · [File by file](../README.md#bundle-size)

</div>
<Illustration name="bundle" :data="$frontmatter.size" label="A page imports kv and downloads 17.1 kB. When a click handler calls openDb, the SharedWorker chunk (11.5 kB) and the wasm engine (16.3 kB) load, 27.8 kB more." />
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
