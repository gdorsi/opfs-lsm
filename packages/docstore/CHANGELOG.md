# @opfs-lsm/docstore

## 0.3.0

### Minor Changes

- bf1f2fc: Queries no longer compare the whole stored catalog. Every `query`, `queryIds` and `count` checks that the collection's schema has not changed since the handle bound it, and that check compared the stored catalog JSON byte for byte. The stored catalog now starts with an 8-byte random revision, written fresh on every catalog change, and the check compares only that revision. Opening a store whose stored schema already matches the declared one now reads the catalog and writes nothing. In the `tracker/goals` benchmark, `assigneeLoad` went from 3.18 ms to 2.28 ms (median of 8 runs each).
  
  This changes the stored format. A database written by an earlier version fails to open with `CorruptDatabaseError`. `destroyDb(name)` from `@opfs-lsm/kv` empties it.
- b42ffa0: A collection is declared with `collection<T>()` and one method per kind of index: `index`, `unique` and `text`. `defineSchema<{ todos: Todo }>()({ ... })` is gone, with the index objects it took. `defineSchema(schema)` now takes one call and returns its argument typed. `IndexDecl` is no longer exported; `CollectionDecl` is the type of a declaration.
  
  Before:
  
  ```ts
  const schema = defineSchema<{ todos: Todo }>()({
  	version: 1,
  	collections: {
  		todos: {
  			open: { by: ["done", "createdAt"] },
  			byTag: { by: "tags[]" },
  			byTitle: { by: "title", unique: true },
  			search: { by: "createdAt", text: "title" },
  		},
  	},
  });
  ```
  
  After:
  
  ```ts
  const schema = defineSchema({
  	version: 1,
  	collections: {
  		todos: collection<Todo>()
  			.index("open", ["done", "createdAt"])
  			.index("byTag", "tags[]")
  			.unique("byTitle", "title")
  			.text("search", "createdAt", "title"),
  	},
  });
  ```
  
  A text index cannot be unique and cannot start with an array field, and an index name cannot repeat: each is a type error now. Every method returns a new declaration, so a base declaration can be shared. The stored catalog does not change, so an existing database opens as before.
- aaa559c: A query takes `offset`: the results to pass over before the first one. It walks the index entries it passes and reads none of their documents. `count` passes over them too.
  
  `getMany`, `get` and `query` parse each document from the bytes kv holds, with no copy between, and `getMany` is one kv read: every document sees the same writes. A query reads the catalog the same way, and it no longer reads the document of the entry past `limit`, which only tells that a next page exists. In the `tracker/goals` benchmark on an Apple M2 Pro (medians of 5 runs before and after, warm), a window of 50 rows at 90% of a project's list went from 0.785 ms to 0.400 ms with `offset`, the column a bulk edit just emptied from 1.02 ms to 0.687 ms, and the issue counts per status from 0.179 ms to 0.146 ms.
- b351ad9: `queryEntries(q)` is new on a collection and on a `view` snapshot. It takes the same query as `queryIds` and returns `{ entries, next }`, where each entry is `{ id, values }`: the document id and the values its index orders it by. It reads no document, so a page of index values costs what `queryIds` costs. Use it to group or merge on indexed fields without loading the documents. In the `tracker/goals` benchmark, counting open issues per assignee with one `queryEntries` went from 3.33 ms to 0.60 ms, and the triage page, which merges four index ranges before loading 50 documents, went from 1.06 ms to 0.78 ms (median of 6 runs each).
- 7c7f4e3: `collection(validator)` takes a Standard Schema validator (zod, valibot, arktype and others) in place of a type: `collection(Todo).index("byCreated", "createdAt")`. The documents are the validator's output, writes take its input, and `put`, `putMany`, `modify` and `modifyMany` store what the validator returns. A rejected document throws `DocStoreError` "invalid" with the validator's `issues` and the `ids` of the document, and so does a validator that returns a Promise, with no issues. Nothing is stored then. Reads never validate. A schema can mix validated collections and collections declared with `collection<T>()`. Validators are not stored: a change to one needs no `version` bump.

### Patch Changes

- 43a4780: A collection's `closed` change event carries kv's `reason`: `"close"` when the kv handle was closed, `"destroyed"` when `destroyDb` removed its database.
- 4b1a235: A write that replaces a document compares its old and new index entries byte by byte when each side has 16 entries or fewer. It built a string per index key and a `Map` for every document.
- 25988a7: A store stays usable after `dangerousDestroy`. Until any store wrote a catalog again, its reads and writes threw `CorruptDatabaseError: the docstore catalog is gone`, whether the destroy came from its own kv handle or from another tab. It now reads the emptied database as empty, and its next write stores the catalog that a fresh open would write. A `clear` whose sweep had not run when the destroy landed no longer deletes the documents written after the destroy.
- 994a789: A document id and a text index value encode into one reused buffer and are copied out, which skips the allocation `TextEncoder.encode` makes on every call. The stored bytes are the same.
- 02a506c: The README's "Storage quota" section answers kv's `db.onStorageFull`, which replaces `maxBytes` and `db.onPressure`.
- b4fb28b: A `query`, `queryIds`, `count` or `view` that started before a `clear` no longer makes later `get` and `getMany` calls return the documents the clear removed.
- 830fa2a: Smaller bundles: `openDb` ships about 760 bytes less brotli and `openDocStore` about 800 less, with no change to the app API, to the disk format or to any read or write path. Two changes to the `@opfs-lsm/kv/testing` entry come with it: `EngineHost.compact(name)` is gone, since the SharedWorker no longer ships a method that only tests call, and the `trace` option of `openHarnessDb` is gone with the `OpenTrace` and `OpenSpan` types and the open timing they recorded.
- 34430fb: `@opfs-lsm/kv/tuple` is a new subpath export. It encodes a tuple of null, booleans, finite numbers and strings as key bytes that sort in tuple order, decodes them, and returns the `KeyBounds` of every key that continues a tuple. To scan the keys under a tuple prefix, use `tupleBounds`, not `prefixBound`. `prefixBound` also returns the keys where the last string of the prefix goes on with U+0000, so `["a"]` would match `["a\u0000b"]`. The main `@opfs-lsm/kv` entry is unchanged. `@opfs-lsm/docstore` now imports this codec instead of carrying a copy, and writes the same key bytes.
- d05b833: A document id, a fate storage key or an Automerge storage key segment that starts with U+FEFF now comes back with it. Reads, queries and scans used to drop the leading U+FEFF, because the UTF-8 decoder treated it as a byte order mark, so `"\uFEFFa"` came back as `"a"`.
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
  - @opfs-lsm/kv@0.3.0

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
