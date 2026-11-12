---
layout: home
title: opfs-lsm
hero:
  name: opfs-lsm
  text: A key-value store for the browser
  tagline: Built to be the storage layer under local-first apps and sync engines. Every tab of your app shares one database and sees the other tabs' writes live.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/#quickstart
    - theme: alt
      text: Why not IndexedDB?
      link: /guide/#why-not-just-use-indexeddb
    - theme: alt
      text: GitHub
      link: https://github.com/gdorsi/opfs-lsm
features:
  - title: Up to 7× faster writes than IndexedDB
    details: Random writes in batches of 1,000 run at 302k ops/s, against 43.4k on IndexedDB. Point reads run 30× faster, and reads of missing keys 127×. Single awaited puts and opening a database are slower.
    link: /guide/#benchmarks
    linkText: All benchmarks
  - title: One database for every tab
    details: A SharedWorker, a background script that every tab of a site can reach, writes the data to OPFS, the Origin Private File System that the browser keeps private to your site. Each tab reads those files directly, and a change feed tells it about the other tabs' writes.
    link: /guide/#how-it-works
    linkText: How it works
  - title: A number for every write
    details: put, delete and batch resolve with the sequence number of their record, and the change feed reports the same numbers. Use them as a cursor for an outbox or a sync checkpoint.
    link: /kv/#db
    linkText: Db methods
  - title: 17.0 kB to import
    details: Importing kv adds 17.0 kB gzip to your main bundle. The SharedWorker and the WebAssembly engine, compiled code that the browser runs next to your JavaScript, load only when a page opens a database.
    link: /guide/#bundle-size
    linkText: Bundle size
  - title: Documents and indexes
    details: docstore keeps JSON documents in collections, with indexes declared in a versioned schema, paged queries, snapshot reads and a change feed.
    link: /docstore/
    linkText: docstore
  - title: TanStack DB, Yjs and Automerge
    details: Adapters keep TanStack DB collections, Yjs documents or an automerge-repo in one kv database.
    link: /tanstack-db/
    linkText: Adapters
---

> [!WARNING]
> opfs-lsm is not stable yet. Expect breaking changes, including to the on-disk format, so data written by one version may not open in the next. The packages are not on npm yet. Until the first release, build them from source as [Set up and release](../CONTRIBUTING.md) describes.

On desktop, kv needs Chrome or Edge 92, Firefox 114 or Safari 26. Firefox, Safari and mobile browsers are not tested yet. The [Overview](../README.md#browser-support) lists the minimum per browser.
