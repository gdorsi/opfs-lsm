---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises. The promises are WAL ack visibility across ingest, memtable-over-SST reads, OCC conflicts, view pins, and compaction merge. Use when changing ingest, the memtable, openGeneration, currentReaders, loadLatestGeneration, transaction OCC, view snapshots, SST merge, or any bug where get, view, or a transaction can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put` or `batch` ack, `get` still sees the value until a later write supersedes it, including across `ingestAll`. | Client saw success. A later `get` misses because `advanceIngested` ran before `publishGeneration`. |
| **WalOverSst** | The memtable row wins over SST, including tombstones. | Stale SST value, or a deleted key comes back. |
| **OccSafety** | `transaction` commit throws `ConflictError` exactly when a WAL record after `snapshotHead` touches a read or written key. Otherwise commit appends. | Lost update, or a false conflict. |
| **ViewPin** | `view()` and `ViewSnapshotImpl` get ignore WAL appends after the pin. | The snapshot changes during the callback. |
| **CompactPreserve** | Newest-first SST merge keeps the same per-key result as `pointGetSst`. | Compact drops a key or brings a deleted key back. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`, memtable) | `formal:kv`, or at least `formal:ingest-visibility` |
| `idb/wal.ts` `memGet` or `collectMem`, `store/merge.ts` `pointGet`, `db.ts` `get` | `formal:wal-over-sst` and `formal:ingest-visibility` |
| `db.ts` `openGeneration`, `currentReaders`, `dropInstalledGeneration`, or port `generation` in `createPortIngestClient` | `formal:kv` for ingest order. The suite does not model this cache. Also run `pnpm --filter @opfs-lsm/kv two-tab`. |
| `transaction.ts` OCC | `formal:occ` |
| `view.ts`, `db.ts` `openViewSnapshot` | `formal:view-pin` |
| `store/merge.ts` `pointGetSst`, `store/fold.ts` `foldEntries`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| Unknown, or several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await order and check order. The checkers use repo `tsx` and `pnpm`. Ingest step order is parsed from `ingest.ts`. The OCC check asserts that `ConflictError` and `watched.has` still exist in `transaction.ts`. The view check asserts that `this.rows = rows.slice()` still exists in `view.ts`. The compact check asserts newest-first `pointGetSst` in `merge.ts` and oldest-first `foldEntries` in `fold.ts`.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual commands are `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:occ`, `formal:view-pin`, and `formal:compact-preserve`.

Exit `0` means the selected checks pass. Failures print a shortest path, or counterexample inputs, in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, at most 2 appends, one in-flight ingest. Omits compact, the multi-tab `openGeneration` cache, crash, and the empty-manifest walk in `loadLatestGeneration`. |
| WalOverSst | 1 key. Every pair of memtable hit and SST hit (`miss`, `tomb`, or two values) on real `pointGet`. |
| OccSafety | keys `{a,b}`, depth at most 8. Omits multi-op batches inside one WAL record. |
| ViewPin | at most 3 appends. Models pin versus live binding. Omits an SST generation bump during the view. |
| CompactPreserve | at most 2 runs, keys `{a,b}`, cell in {miss, put1, put2, del}. Omits Bloom false negatives and reclaim races. |

A pass covers the model and domain above. It does not cover the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks.** A path where `advanceIngested` runs before `publishGeneration`, and model `resolveGet` is undefined.
- **OccSafety.** `tx.commit` returns ok while a concurrent append touched a watched key, or the reverse. Or `transaction.ts` lost `ConflictError` or `watched.has`.
- **ViewPin.** `view.get` sees an append from after the pin. Or `view.ts` no longer assigns `this.rows = rows.slice()`.
- **CompactPreserve.** The merge result disagrees with `pointGetSst`. Or `merge.ts` no longer walks readers newest-first, or `fold.ts` no longer applies oldest-first.
- **Modeling error.** The path is impossible in TS, or a parser or source-sync check is out of date. Fix the formal files. Do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestAll`, `publishL0`, `publishGeneration`, `advanceIngested`. The model read is `resolveGet` over the mem cell. Product `get` uses `memGet`, then `currentReaders`. |
| WalOverSst | `pointGet`, `MemRow`, `SstReader` |
| OccSafety | `TxImpl.commit`, `runTransaction`, `ConflictError` |
| ViewPin | `ViewSnapshotImpl`, `rows.slice()` |
| CompactPreserve | `pointGetSst`, `foldEntries`, `mergeSsts` |

The sync commit is `8e45a26dffe39a32eee473bb9b64079114030171`. `formal:kv` passed on this commit. The symbols above match that tree. Move the pointer only after `formal:kv` passes again and the models still match.

## Product symbols this suite does not encode

`openGeneration` and `currentReaders` live on `DbImpl` in `db.ts`. `dropInstalledGeneration` sets `openGeneration` to undefined. The local ingest scheduler calls that clear. A BroadcastChannel `ingest` from another writer calls it too.

Port generation handling is `createPortIngestClient` in `host/engine-host.ts`, `case "generation"`. `openDb` passes a callback that calls `dropInstalledGeneration` for that database name. The SharedWorker posts `{ type: "generation", name, generation }` from `bootSharedWorker`.

`loadLatestGeneration` in `store/generation.ts` lists `m/*.mft` from newest to oldest. The empty-manifest walk skips a zero-length file or a manifest that throws `CorruptDatabaseError`, and it returns the newest manifest that decodes. When every manifest is empty or corrupt, it returns undefined.

## Intentional product change

1. Edit the product code.
2. Update the matching files under `packages/kv/formal/`.
3. Run `pnpm --filter @opfs-lsm/kv formal:kv`.
4. Replace the sync commit SHA with `git rev-parse HEAD`.

Drift without a recheck goes to `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

`formal:kv` does not encode the product symbols in the section above.

- A crash between `publishGeneration` and `advanceIngested` (recovery).
- OCC versus ingest truncating WAL rows for watched keys.
- `maybeCompact` reclaim versus an open view pin (generation lifetime).
