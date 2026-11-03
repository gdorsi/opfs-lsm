---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: WAL ack visibility across ingest, WAL-over-SST reads, OCC conflicts, view pins, and compaction merge. Use when changing ingest, WAL, resolveGet/readLayers, transaction OCC, view snapshots, SST layer merge/compaction, or any bug where get/view/txn can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put`/`batch` ack, `get` still sees the value until a later write supersedes it — including across `ingestAll`. | Client saw success; later `get` misses because `advanceIngested` beat `publishGeneration`. |
| **WalOverSst** | Uningested WAL wins over SST (including tombstones). | Stale SST value or resurrected key after delete. |
| **OccSafety** | `transaction` commit throws `ConflictError` iff a WAL record after `snapshotHead` touches a read/written key; otherwise commit appends. | Lost update, or false conflicts. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores WAL appends after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get. | Compact drops or resurrects keys. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`) | full suite (or at least `formal:ingest-visibility`) |
| `store/overlay.ts` `resolveGet`, `db.ts` `readLayers`/`get` | `formal:wal-over-sst` + ingest |
| `transaction.ts` OCC | `formal:occ` |
| `view.ts`, `db.ts` `openViewSnapshot` | `formal:view-pin` |
| `store/sst-layer.ts`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await/check order. No JVM — uses repo `tsx`/`pnpm`. Ingest step order is **parsed from** `ingest.ts`. OCC / view / compact checks also assert the relevant control flow still exists in source so a deleted conflict check or missing `cloneOverlay` fails the suite.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:occ`, `formal:view-pin`, `formal:compact-preserve`.

Exit `0` = all selected checks pass. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, ≤2 appends, one in-flight ingest; omits compact, multi-tab cache, crash |
| WalOverSst | 1 key; all WAL×SST hit kinds (`miss`/`tomb`/two values) on **real** `resolveGet` |
| OccSafety | keys `{a,b}`, depth ≤8; omits multi-op batches inside one WAL record |
| ViewPin | ≤3 appends; models pin vs live binding; omits SST generation bump mid-view |
| CompactPreserve | ≤2 runs, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; omits Bloom false negatives, reclaim races |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks:** path with `advanceIngested` before `publishGeneration` and `resolveGet` undefined.
- **OccSafety:** `tx.commit` → `ok` while a concurrent append touched a watched key (or the reverse); or `transaction.ts` lost `ConflictError`/`watched.has`.
- **ViewPin:** `view.get` sees a post-pin append; or `cloneOverlay` removed from `view.ts`.
- **CompactPreserve:** before/after merge disagree; or `sst-layer.ts` no longer newest-first `get`.
- **Modeling error:** path impossible in TS, or parser/source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestAll`, `publishL0`/`publishGeneration`/`advanceIngested`, `resolveGet`, `readLayers` |
| WalOverSst | `KeyOverlay`, `resolveGet` |
| OccSafety | `TxImpl.commit`, `runTransaction`, `ConflictError` |
| ViewPin | `ViewSnapshotImpl`, `openViewSnapshot` |
| CompactPreserve | `SstLayer.get` / `asOverlay`, `mergeSsts` order |

**Sync commit:** `af794f790f1a631460a7c989be54080f3575b153` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- Multi-tab `layersStale` / BroadcastChannel vs SST generation bump.
- Crash between `publishGeneration` and `advanceIngested` (recovery).
- OCC vs ingest truncating watched keys’ WAL rows.
- `maybeCompact` reclaim vs open view pin (generation lifetime).
