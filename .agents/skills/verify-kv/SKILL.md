---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: WAL ack visibility across ingest, WAL-over-SST reads, view pins, and compaction merge. Use when changing ingest, WAL, pointGet, view snapshots, SST merge/compaction, or any bug where get/view can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put`/`batch` ack, `get` still sees the value until a later write supersedes it — including across `ingestAll`. | Client saw success; later `get` misses because `advanceIngested` beat `publishGeneration`. |
| **WalOverSst** | Uningested WAL wins over SST (including tombstones). | Stale SST value or resurrected key after delete. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores WAL appends after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get. | Compact drops or resurrects keys. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`) | full suite (or at least `formal:ingest-visibility`) |
| `store/merge.ts` `pointGet`, `db.ts` `readKey` / `get` | `formal:wal-over-sst` + ingest |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, `store/memtable.ts` `pin` | `formal:view-pin` |
| `store/merge.ts` `latestSstEntry`, `store/fold.ts` `foldEntries`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await/check order. No JVM — uses repo `tsx`/`pnpm`. Ingest step order is **parsed from** `ingest.ts`. View and compact checks also assert the relevant control flow still exists in source, so a missing `mem.pin()` copy or a reversed `latestSstEntry` / `foldEntries` loop fails the suite.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`.

Exit `0` = all selected checks pass. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, ≤2 appends, one in-flight ingest; omits compact, multi-tab cache, crash |
| WalOverSst | 1 key; all WAL×SST hit kinds (`miss`/`tomb`/two values) on **real** `pointGet` |
| ViewPin | ≤3 appends; models pin vs live binding; omits SST generation bump mid-view |
| CompactPreserve | ≤2 runs, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; omits Bloom false negatives, reclaim races |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks:** path with `advanceIngested` before `publishGeneration` and model `resolveGet` undefined.
- **ViewPin:** `view.get` sees a post-pin append; or `db.ts` no longer passes `this.mem.pin()` into `ViewSnapshotImpl`, or `memtable.ts` drops the copy-on-write pin.
- **CompactPreserve:** before/after merge disagree; or `merge.ts` / `fold.ts` no longer newest-first get / oldest-first apply.
- **Modeling error:** path impossible in TS, or parser/source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestAll` order: `publishL0`, `publishGeneration`, `advanceIngested` |
| WalOverSst | `pointGet` |
| ViewPin | `ViewSnapshotImpl`, `Db.view`, `Memtable.pin` |
| CompactPreserve | `latestSstEntry`, `foldEntries` (TypeScript path of `mergeSsts`) |

**Sync commit:** `682b4d8a8118065340ea30d9bd83142d264fb2a3` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- Multi-tab BroadcastChannel versus an SST generation bump.
- Crash between `publishGeneration` and `advanceIngested` (recovery).
- Compaction reclaim versus an open view pin (generation lifetime).
- `pendingBytes` on the WAL and in `EngineHost` (the ingest trigger). The checks do not model it.
