# @opfs-lsm/tanstack-db

## 0.3.0

### Patch Changes

- Updated dependencies [bf1f2fc]
- Updated dependencies [43a4780]
- Updated dependencies [b42ffa0]
- Updated dependencies [4b1a235]
- Updated dependencies [25988a7]
- Updated dependencies [994a789]
- Updated dependencies [aaa559c]
- Updated dependencies [b351ad9]
- Updated dependencies [02a506c]
- Updated dependencies [7c7f4e3]
- Updated dependencies [b4fb28b]
- Updated dependencies [44be297]
- Updated dependencies [830fa2a]
- Updated dependencies [65a7368]
- Updated dependencies [92dd1a4]
- Updated dependencies [4ffe314]
- Updated dependencies [a61d279]
- Updated dependencies [206b371]
- Updated dependencies [5163013]
- Updated dependencies [578fbd7]
- Updated dependencies [bfcee61]
- Updated dependencies [e42c671]
- Updated dependencies [02a506c]
- Updated dependencies [802afdd]
- Updated dependencies [c87f21f]
- Updated dependencies [aaa559c]
- Updated dependencies [cb12766]
- Updated dependencies [eb1497d]
- Updated dependencies [34430fb]
- Updated dependencies [58de646]
- Updated dependencies [41a7777]
- Updated dependencies [51a92e6]
- Updated dependencies [d05b833]
  - @opfs-lsm/docstore@0.3.0
  - @opfs-lsm/kv@0.3.0

## 0.2.1

### Patch Changes

- 0a3e09c: First public release of the @opfs-lsm packages: a browser key-value store on OPFS with a live change feed, a document store with indexes on top of it, and Yjs, Automerge, TanStack DB and fate sync adapters.
- Updated dependencies [0a3e09c]
  - @opfs-lsm/kv@0.2.1
  - @opfs-lsm/docstore@0.2.1

## 0.2.0

### Minor Changes

- 268c28f: New package. `kvCollectionOptions({ db, name, getKey })` keeps a TanStack DB collection in an `@opfs-lsm/kv` db. It persists every insert, update and delete as one kv batch per transaction, loads the collection's rows on start, and applies other tabs' writes from kv's change feed as they arrive. `utils.acceptMutations` persists a manual transaction.
- e988526: `onDemand: { plan }` makes a collection load only what live queries ask for (`syncMode: "on-demand"`). `plan` turns a query's subset into keys or a string key prefix, the adapter reads them in one kv view, follows writes to the rows a loaded plan covers, and drops rows from memory when no loaded plan covers them.
- 8907acf: `docstoreCollectionOptions({ collection, syncMode })` replaces `kvCollectionOptions`. A collection lives in an `@opfs-lsm/docstore` collection and is keyed by its documents' `id`. An on-demand collection reads each live query's rows through the docstore collection's indexes, with no `plan` to write: a `where` on `id` reads those documents, `eq` and `inArray` on an index's leading fields read one range per value, and an ordered, limited query reads only the first rows of each range. `utils.transact(ids, merge)` is docstore's `modifyMany`. `kvCollectionOptions`, with `getKey`, `codec`, `onDemand` and number keys, is removed.
- 079cc08: An on-demand collection now reads a text index for a query without a `like` on its text, as it reads a sorted index, so one text index can serve both a search and the plain order. Without a `match`, a sorted index that pins as many fields is still preferred. A load without `orderBy`, such as TanStack's load of the rows tied with a window's last row, takes among the indexes that pin the most fields the one with the fewest left unpinned. A text index holds only documents with a string at its text field: a document without one is not read through it.
- 83687a8: `utils.transact(keys, merge)` reads rows and writes the result in one kv `update`, so no other write lands between the read and the write. `merge` returns a row to put, `null` to delete or `undefined` to leave each key, and the promise resolves once the collection shows the write (an eager collection always does, an on-demand one for the keys a loaded plan covers; other keys persist but stay out of memory).

### Patch Changes

- 69f7830: Declare an index's fields with `by` instead of `on`, and mark an array field with a `[]` suffix instead of `multi: true`. For example, `{ on: "tags", multi: true }` becomes `{ by: "tags[]" }`. `defineSchema` now rejects a misspelled option such as `uniqe` at compile time, and opening a schema with an unknown option, `on` and `multi` included, throws `DocStoreError "schema"`. `IndexInfo.on` is now `IndexInfo.by`, with `[]` on the first field of a multi index. The stored catalog is unchanged, so existing databases open as before.
- 83ce8e1: Every package now declares `sideEffects` in its `package.json`, so webpack and esbuild drop the modules an app does not import. With webpack, an app that imports only the error classes from `@opfs-lsm/kv` bundles 135 bytes brotli instead of 438, and no longer gets the SharedWorker chunk and the wasm file in its build output.
- ebcdf51: An on-demand collection no longer reads every document when one live query is released while another loads its first page. It used to drop the released query's rows in the commit that delivered the other query's page. TanStack had already handed some of those rows to the loading query, so it saw them disappear before its load settled and asked for the whole collection. Rows that no live query keeps now leave memory once every load has settled.
- 432581a: An on-demand ordered, limited query whose load found fewer rows than its limit now lets rows go once writes fill it: it keeps the rows at or before the one at its limit, as a load would. It used to keep every matching row written after its load, so a list opened on an empty replica held every row a first sync wrote.
- Updated dependencies [a410ea1]
- Updated dependencies [912ab8a]
- Updated dependencies [2edac58]
- Updated dependencies [594b30b]
- Updated dependencies [cad8e27]
- Updated dependencies [b319e37]
- Updated dependencies [7eccd98]
- Updated dependencies [3c8c6f2]
- Updated dependencies [69f7830]
- Updated dependencies [a356ebe]
- Updated dependencies [61b9a4f]
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
  - @opfs-lsm/docstore@0.2.0
