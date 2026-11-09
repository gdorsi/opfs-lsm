---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: unstable log rows over SST reads, view pins, and compaction merge. Use when changing pointGet, view snapshots, the memtable pin, or SST merge/compaction, or for any bug where get/view can disagree with a successful put. Crash recovery and acked writes across tabs are checked on the real code by tests/sim, not here."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **WalOverSst** | A memtable row (log records not yet ingested) wins over SST, tombstones included. | Stale SST value or resurrected key after delete. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores log records applied after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get. | Compact drops or resurrects keys. |

The per-tab logs have no formal model. Their properties are checked on the real code:

| Property | Checked by |
|---|---|
| No lost acks: every acked write stays visible across tabs, ingests and reopens | `tests/sim/multi-handle.test.ts` (and `model.test.ts` for one handle) |
| Process crash keeps every acked write; power loss reopens to the merge of a prefix of each log; recovery leaves a healthy database | `tests/sim/crash-enum.test.ts` |
| Corruption is refused with nothing written, not mistaken for a power loss | `tests/sim/corruption.test.ts` |

The old `NoLostAcks`, `PowerPrefix` and `CorruptRefuse` checks modeled the IndexedDB log and are retired.

## When to run

| Change touches | Run |
|---|---|
| `store/merge.ts` `pointGet`, `db.ts` `readKey` / `get` | `formal:wal-over-sst` |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, `store/memtable.ts` `pin` | `formal:view-pin` |
| `store/merge.ts` `latestSstEntry`, `store/fold.ts` `foldEntries`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| `src/log/`, `host/ingest.ts`, `recover.ts`, `host/compact.ts` `installStep`, `EngineHost.reclaim` / `fold`, the reclaim lock, manifest numbering, the open path | Not this suite: `tests/sim/multi-handle.test.ts`, `tests/sim/crash-enum.test.ts` and `tests/sim/corruption.test.ts`, with the long sweeps in `docs/verification.md` |
| Unknown / several areas | **`formal:kv`** (all), plus `pnpm test` |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product control flow. No JVM — uses repo `tsx`/`pnpm`. View and compact checks also assert the relevant control flow still exists in source, so a missing `mem.pin()` copy or a reversed `latestSstEntry` / `foldEntries` loop fails the suite.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`.

Exit `0` = all selected checks pass; the log ends with `All 3 formal checks passed`. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| WalOverSst | 1 key; all memtable×SST hit kinds (`miss`/`tomb`/two values) on **real** `pointGet` |
| ViewPin | ≤3 appends; models pin vs live binding; omits SST generation bump mid-view; the pin of the tab's own unstable rows is a source guard only |
| CompactPreserve | ≤2 runs, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; omits Bloom false negatives, reclaim races |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, log workers, OPFS crashes).

## Reading failures

- **WalOverSst:** `pointGet` returned the SST value where a memtable row (or tombstone) exists.
- **ViewPin:** `view.get` sees a post-pin append; or `db.ts` no longer passes `pinRows()` (the memtable pin plus `LogSession.pinOwnRows`) into `ViewSnapshotImpl`, or `memtable.ts` drops the copy-on-write pin.
- **CompactPreserve:** before/after merge disagree; or `merge.ts` / `fold.ts` no longer newest-first get / oldest-first apply.
- **Modeling error:** path impossible in TS, or source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| WalOverSst | `pointGet` |
| ViewPin | `ViewSnapshotImpl`, `Db.view`, `Db.pinRows`, `LogSession.pinOwnRows`, `Memtable.pin` |
| CompactPreserve | `latestSstEntry`, `foldEntries` (TypeScript path of `mergeSsts`) |

**Sync commit:** `7f3a256e2d968dd591309d944321d975020b3561` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- A model of the per-tab log protocol: the watermark, promises, join and `update`'s reservation.
- Compaction reclaim versus an open view pin (generation lifetime).
- The ingest trigger (each tab's count of stable log bytes and its `ingest-request`). The checks do not model it.
