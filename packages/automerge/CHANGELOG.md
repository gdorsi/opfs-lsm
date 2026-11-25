# @opfs-lsm/automerge

## 0.4.0

### Patch Changes

- c3cd729: The README states the exact chunk limit: a chunk with its key and 256 bytes is at most 8 MiB, kv's batch limit.
- eeaff75: A storage key with a segment past 65,535 bytes now throws `ConstraintError`, as every other key over 8 KiB does. It threw a plain `Error`.
- 891c829: `removeRange` removes a key range with one range delete. It no longer reads the range before it deletes it.
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
