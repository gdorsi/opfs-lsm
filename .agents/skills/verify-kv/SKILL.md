---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: WAL ack visibility across ingest, WAL-over-SST reads, view pins, compaction merge, and power-loss recovery. Use when changing ingest, WAL, pointGet, view snapshots, SST merge/compaction, reclaim, recovery (reconcile/adopt), or any bug where get/view can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put`/`batch` ack, `get` still sees the value until a later write supersedes it — including across `ingestAll`. | Client saw success; later `get` misses because `advanceIngested` beat `publishGeneration`. |
| **WalOverSst** | Uningested WAL wins over SST (including tombstones). | Stale SST value or resurrected key after delete. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores WAL appends after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get. | Compact drops or resurrects keys. |
| **PowerPrefix** | After any power loss (IndexedDB and OPFS each keep a prefix of their own writes, unordered), the database opens and reads the writes of one log prefix; a process crash keeps every acked write; recovery leaves a healthy database. | Database will not open, or reads a state no prefix of the log produced. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`) | full suite (or at least `formal:ingest-visibility`) |
| `store/merge.ts` `pointGet`, `db.ts` `readKey` / `get` | `formal:wal-over-sst` + ingest |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, `store/memtable.ts` `pin` | `formal:view-pin` |
| `store/merge.ts` `latestSstEntry`, `store/fold.ts` `foldEntries`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| `recover.ts`, `idb/wal.ts` (`adopt`, `advanceIngested`), `host/ingest.ts`, `host/compact.ts` `installStep`, `EngineHost.reclaim`, manifest numbering, `openDb` / `syncOnce` repair | `formal:power-loss` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await/check order. No JVM — uses repo `tsx`/`pnpm`. Ingest step order is **parsed from** `ingest.ts`. View and compact checks also assert the relevant control flow still exists in source, so a missing `mem.pin()` copy or a reversed `latestSstEntry` / `foldEntries` loop fails the suite.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:power-loss`.

Exit `0` = all selected checks pass. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, ≤2 appends, one in-flight ingest; omits compact, multi-tab cache, crash |
| WalOverSst | 1 key; all WAL×SST hit kinds (`miss`/`tomb`/two values) on **real** `pointGet` |
| ViewPin | ≤3 appends; models pin vs live binding; omits SST generation bump mid-view |
| CompactPreserve | ≤2 runs, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; omits Bloom false negatives, reclaim races |
| PowerPrefix | Workloads of ≤6 appends/ingests/compactions (`FORMAL_POWER_CMDS`), every (IndexedDB, OPFS) prefix pair, recovery then 4 more commands, and every pair of the next power loss, 2 deep (`FORMAL_POWER_CRASHES`). Writes are abstract ids, so values and folding are not modeled; one tab, one host, compaction merges every run of the base. Must also catch 5 broken variants. |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks:** path with `advanceIngested` before `publishGeneration` and model `resolveGet` undefined.
- **ViewPin:** `view.get` sees a post-pin append; or `db.ts` no longer passes `this.mem.pin()` into `ViewSnapshotImpl`, or `memtable.ts` drops the copy-on-write pin.
- **CompactPreserve:** before/after merge disagree; or `merge.ts` / `fold.ts` no longer newest-first get / oldest-first apply.
- **PowerPrefix:** the first crash state (what each store kept), then each nested recovery crash, and the read that is not a prefix, the open that fails, or the `checkDatabase`-style problem. `model too weak` means a broken variant passed: the model lost a behavior the product depends on. `source sync` names a product decision the model encodes that the code no longer makes.
- **Modeling error:** path impossible in TS, or parser/source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestAll` order: `publishL0`, `publishGeneration`, `advanceIngested` |
| WalOverSst | `pointGet` |
| ViewPin | `ViewSnapshotImpl`, `Db.view`, `Memtable.pin` |
| CompactPreserve | `latestSstEntry`, `foldEntries` (TypeScript path of `mergeSsts`) |
| PowerPrefix | `reconcile`, `IdBWal.adopt`, `IdBWal.advanceIngested` retention, `ingestAll` and `installStep` building on the recorded generation and numbering past `top`, `EngineHost.reclaim`, `openDb` and `syncOnce` repair (`formal/power-loss/model.ts`, regex guards in `check.ts`) |

**Sync commit:** `4f56f230900213d955efb7ec3552441bb83b1d6c` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- Multi-tab BroadcastChannel versus an SST generation bump.
- Compaction reclaim versus an open view pin (generation lifetime).
- `pendingBytes` on the WAL and in `EngineHost` (the ingest trigger). The checks do not model it.
