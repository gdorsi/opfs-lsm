# @opfs-lsm/tanstack-query

## 0.5.0

### Patch Changes

- Updated dependencies [63a1f5a]
- Updated dependencies [c443397]
- Updated dependencies [147387f]
- Updated dependencies [71f146f]
- Updated dependencies [901139c]
- Updated dependencies [082a174]
- Updated dependencies [219bc51]
- Updated dependencies [79b6b33]
- Updated dependencies [f5a1d19]
  - @opfs-lsm/kv@0.5.0

## 0.4.0

### Minor Changes

- b189919: New package. `createQueryPersister(db)` returns TanStack Query's per-query persister with kv as its storage, one kv entry per query. The whole-client persister is not supported, because kv rejects a value over 8 MiB and `createAsyncStoragePersister` drops that error.

### Patch Changes

- 4efa3f0: A query whose storage key is over 8 KiB is not found in storage, so `persisterFn` calls `queryFn`. Before, kv rejected the read with `ConstraintError` and the query failed without calling `queryFn`.
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
