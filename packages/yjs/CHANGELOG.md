# @opfs-lsm/yjs

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
