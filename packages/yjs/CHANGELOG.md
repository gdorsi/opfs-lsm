# @opfs-lsm/yjs

## 0.4.0

### Patch Changes

- fa5d4ad: `doc.destroy()` after a failed write no longer causes an unhandled rejection, and a later `destroy()` waits for the same teardown and rejects with its error.
- c7c5e7c: Updates made while a doc loads count toward `trimSize`, so a doc they bring to the threshold merges once quiet. Before, the load dropped them from the count and the doc could stay unmerged. `destroy()` also stores an update that went pending while the persistence was attached, which Yjs announces with no update event. Before, it was lost on reload.
- e108001: `KvPersistence` throws for a document name with a lone surrogate. UTF-8 turned the surrogate into U+FFFD, so such a name read and wrote the updates of another document.
- 81644ba: `whenSynced` rejects with `ConstraintError` for a document name too long for its update keys. Before, a name of 8182 to 8189 bytes loaded, then every flush rejected.
- 7652ca7: A doc whose state is over 8 MiB is no longer merged, and `flush()` and `destroy()` resolve for it while no write of its updates failed. Before, the merge failed on kv's batch limit, and every later `flush()` and `destroy()` rejected with `ConstraintError` although every update was stored.
- 508e1bd: A doc whose only content is a pending update (one that arrived before the update it builds on) is stored when the persistence attaches. Before, that update was lost on reload.
- 74228e2: `KvPersistence` stores the content a doc already holds when the persistence is constructed, as one entry, the way y-indexeddb does. That content fired no update event, so it was never stored and a reload lost it.
- Updated dependencies [4437556]
- Updated dependencies [327c0e8]
- Updated dependencies [66344c2]
- Updated dependencies [488ee4d]
- Updated dependencies [eeaff75]
- Updated dependencies [7d39e3f]
- Updated dependencies [eeaff75]
- Updated dependencies [634bf1a]
- Updated dependencies [df04143]
- Updated dependencies [2def7c4]
- Updated dependencies [402b24d]
- Updated dependencies [fb5b609]
- Updated dependencies [eb929d8]
- Updated dependencies [047eed4]
- Updated dependencies [ec242eb]
- Updated dependencies [3f59e5f]
- Updated dependencies [72d4295]
- Updated dependencies [17f9b12]
- Updated dependencies [ac545e6]
- Updated dependencies [44b72e1]
- Updated dependencies [fa776c8]
- Updated dependencies [33d7488]
- Updated dependencies [3aa934e]
- Updated dependencies [df04143]
- Updated dependencies [a282ddf]
- Updated dependencies [423bec9]
- Updated dependencies [5dee709]
- Updated dependencies [93c2a32]
  - @opfs-lsm/kv@0.4.0

## 0.3.0

### Patch Changes

- 16de687: A merge of a doc's stored updates now waits for the doc's own writes still in flight before it reads. Before, a merge that started while the WAL was behind (a burst of thousands of updates, then a second of quiet) deleted only the updates that had landed and left the rest stored next to the merged state. The next load replayed those before the merged state, without the updates they build on, and Yjs's handling of such updates is quadratic: one cold load took 17 s in the benchmark instead of 15 ms.
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

## 0.1.1

### Patch Changes

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
