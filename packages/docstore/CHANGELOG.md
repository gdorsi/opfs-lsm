# @opfs-lsm/docstore

## 0.2.1

### Patch Changes

- 0a3e09c: First public release of the @opfs-lsm packages: a browser key-value store on OPFS with a live change feed, a document store with indexes on top of it, and Yjs, Automerge, TanStack DB and fate sync adapters.
- Updated dependencies [0a3e09c]
  - @opfs-lsm/kv@0.2.1

## 0.2.0

### Minor Changes

- 69f7830: Declare an index's fields with `by` instead of `on`, and mark an array field with a `[]` suffix instead of `multi: true`. For example, `{ on: "tags", multi: true }` becomes `{ by: "tags[]" }`. `defineSchema` now rejects a misspelled option such as `uniqe` at compile time, and opening a schema with an unknown option, `on` and `multi` included, throws `DocStoreError "schema"`. `IndexInfo.on` is now `IndexInfo.by`, with `[]` on the first field of a multi index. The stored catalog is unchanged, so existing databases open as before.
- 61b9a4f: docstore is now published. A collection gains `indexes`, the indexes its schema declares; `view`, which reads queries and documents from one kv snapshot and reports the snapshot's `seq`; `modifyMany`, a read-modify-write of several documents in one transaction that loses no update to another tab; and `changes`, every change to the collection's documents from every tab, with a `gap` event when the collection is cleared or dropped. Queries now read through a snapshot, so a query that a newer schema's redefinition overtakes returns the state it started in instead of failing with `"schema"`.

### Patch Changes

- 7eccd98: `putMany` into a collection with no index reads no row: the transaction reads only the catalog and writes every document. Such a put no longer skips a document whose stored bytes would not change.
- 3c8c6f2: `get` and `getMany` no longer read the catalog from kv before each read. The store keeps its catalog current from kv's change feed and reads it again only after a `gap`. A read that runs while another tab's `clear` or schema change is still arriving on this handle answers from before that change, as a read just ahead of it would.
- a356ebe: `modify` and `modifyMany` on a collection without a unique index read each document once, inside the kv transaction that writes it, and run `fn` there. Before, they read every document before the transaction and kv read it again inside. A new document's index entries are written without diffing them against an empty list.
- cbd6d5c: Add `tx.deleteRange(bounds, { through? })` to `batch`, which removes every row in `[start, endExclusive)` in one op, however many rows that is. It removes the rows written before its batch, or with `through` only those last written at or below that seq, and never its own batch's puts. Every read skips the removed rows, in every tab, and a `view` opened before it keeps reading them. `changes()` reports it as a `deleteRange` op with its `through` resolved. `KeyBounds` and `DeleteRangeOptions` are exported.
  
  Manifests move to version 4, which records the range deletes. This build refuses a database whose newest manifest is version 3 or older with `CorruptDatabaseError`, and an older build refuses a version 4 manifest the same way; `destroyDb(name)` empties either.
  
  A docstore change feed sends a `gap` when a kv range delete reaches a collection's rows.
- d33afb3: A batch no longer has a limit of 10,000 ops. The limit of 8 MiB per batch stays, and it now counts 256 bytes for each op on top of the key bytes and the value bytes, as the memtable does. A batch of small ops can hold about 30,000 of them. A batch of fewer than 10,000 ops that was within about 2.4 MiB of the limit is now over it. The separate limit of 16 MiB per value is gone: no write could reach it, because a `put` is a batch of one op.
- 83ce8e1: Every package now declares `sideEffects` in its `package.json`, so webpack and esbuild drop the modules an app does not import. With webpack, an app that imports only the error classes from `@opfs-lsm/kv` bundles 135 bytes brotli instead of 438, and no longer gets the SharedWorker chunk and the wasm file in its build output.
- Updated dependencies [a410ea1]
- Updated dependencies [912ab8a]
- Updated dependencies [2edac58]
- Updated dependencies [594b30b]
- Updated dependencies [cad8e27]
- Updated dependencies [b319e37]
- Updated dependencies [b5f8283]
- Updated dependencies [1330fd2]
- Updated dependencies [9d6d98b]
- Updated dependencies [1e3d0b1]
- Updated dependencies [7de83db]
- Updated dependencies [2c55877]
- Updated dependencies [39a80af]
- Updated dependencies [cbd6d5c]
- Updated dependencies [bb30bad]
- Updated dependencies [911ab89]
- Updated dependencies [d33afb3]
- Updated dependencies [f31c858]
- Updated dependencies [b3ea475]
- Updated dependencies [328ae0d]
- Updated dependencies [bbf4302]
- Updated dependencies [9c9e818]
- Updated dependencies [bef2766]
- Updated dependencies [afbf970]
- Updated dependencies [fbe16fb]
- Updated dependencies [f172e80]
- Updated dependencies [5c5730d]
- Updated dependencies [04db272]
- Updated dependencies [9be5912]
- Updated dependencies [83ce8e1]
- Updated dependencies [d5962d5]
- Updated dependencies [e041971]
- Updated dependencies [1d97eaa]
- Updated dependencies [a93f292]
- Updated dependencies [ac8f49f]
  - @opfs-lsm/kv@0.2.0
