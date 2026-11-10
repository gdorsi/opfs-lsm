---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: a page reads its acked writes across ingest, its own records over the runs, view pins, compaction merge, and the per-tab ingest queues under crashes. Use when changing the per-tab logs, the SharedWorker's ingest round, planIngest or planReclaim, the page's install, pointGet, view snapshots, SST merge/compaction, reclaim, or any bug where get/view can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After a `put`/`batch` ack, `get` on that page sees the value until a later write supersedes it, in every interleaving of more appends, the SharedWorker's ingest round, and the page's install of the manifest that round published. | The page acked a write, then a `get` missed it while the host ingested it. |
| **OwnOverRuns** | A page's own records that its installed manifest does not cover win over the runs, tombstones included, in `get`, `range` and `view`. Another page reads the runs alone. | A stale run value, a key back after this page deleted it, or a page reading another page's record before it is ingested. |
| **ViewPin** | `view()` reads the state it opened on while its page writes, ingests and installs, and while another page writes and ingests. | A snapshot changes mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get. | Compact drops or resurrects keys. |
| **IngestPlan** | Over the per-tab logs: no write and no (log, n) ingested twice; each log in record order and after its pred; no acked record skipped below a cursor or in a final log (except past the first record a fault or crash took from that log); a healthy database opens; a crash with at most one dropped manifest and no fault recovers; once every writer is gone, a drain ingests every acked record that was not lost. Every plan numbers its seqs on from its base's `through`. | Lost or doubled writes, a log applied out of order, or a database that will not open after a crash. |

## When to run

| Change touches | Run |
|---|---|
| `host/queue-host.ts` `ingestQueues` (the round's write order), `db.ts` `install` | `formal:ingest-visibility` |
| `log/overlay.ts` `OwnQueue`, `db.ts` reads, `store/merge.ts` `pointGet` | `formal:own-over-runs` |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, the `OwnQueue` or memtable pin | `formal:view-pin` |
| `store/merge.ts` `latestSstEntry`, `store/fold.ts` `foldEntries`, `store/engine.ts` `mergeSsts`, `host/compact.ts` | `formal:compact-preserve` |
| `host/queues.ts` (`planIngest`, `planReclaim`, `checkCover`, `RECLAIM_LAG`), the log segment format or scan (`log/`), hand-over and preds, `host/queue-host.ts` reads and reclaim | `formal:ingest-plan` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers, run with `tsx`. No JVM.

- `ingest-visibility` models the round and the install, with the step order **parsed from** `ingestQueues` and `DbImpl.install`, and must fail two broken orders.
- `own-over-runs` and `view-pin` drive **real** pages over `MemoryFs` and a `Host` on the page, through every case of a small domain.
- `ingest-plan` is a breadth-first search over a model of tabs, logs and the SharedWorker that calls the **real** `planIngest`, `planReclaim` and `checkCover`, and must fail its broken rules.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:ingest-visibility`, `formal:own-over-runs`, `formal:view-pin`, `formal:compact-preserve`, `formal:ingest-plan`.

Exit `0` = all selected checks pass. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, ≤3 appends, one round and one install in flight, one page; omits compaction and other pages |
| OwnOverRuns | 1 key; runs × own record ∈ {none, tombstone, A, B}², 16 pairs, on real pages |
| ViewPin | Up to 3 actions from {own put, own delete, ingest, other page's put + ingest + sync} inside a view, after none or one before it: 420 sequences on real pages. The newest-write check after the view runs only when this page alone wrote. |
| CompactPreserve | ≤2 runs, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; omits Bloom false negatives, reclaim races |
| IngestPlan | Two tabs, ≤2 appends each (`FORMAL_IQ_APPENDS`), ≤3 commits (`FORMAL_IQ_COMMITS`), one record per segment (`FORMAL_IQ_SEGCAP`), up to two dropped manifests. `FORMAL_IQ_FAILED_OPEN=1` adds a successor that cannot open, at about twice the time. About 50 s at the defaults. |

A pass is for the model or domain above, not the whole browser stack (SharedWorker ports, OPFS crashes): see `verify-opfs-lsm` and the kill loop in `docs/verification.md`.

Two results are printed as findings, not gated: reclaim lagging one generation survives one dropped manifest but not two (why `RECLAIM_LAG` is 2), and after a dropped manifest the recovery round can ingest a page's write before a write of another log that the page had seen ingested. `tests/sim/crash-enum.test.ts` accepts the same reorder after lost manifests.

## Reading failures

- **NoLostAcks:** a path where the manifest is published before its run, or the page drops its own records before it swaps in the runs that hold them, with a task between.
- **OwnOverRuns / ViewPin:** the (runs, own) pair or the action sequence, and the read that differs.
- **CompactPreserve:** before/after merge disagree; or `merge.ts` / `fold.ts` no longer newest-first get / oldest-first apply.
- **IngestPlan:** the shortest path of tab, SharedWorker and crash steps, then the property it breaks. `model too weak` means a broken rule passed.
- **Modeling error:** path impossible in TS, or parser out of date: fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestQueues` order (`publishL0`, then `publishGeneration` with the cursors), `DbImpl.install` (swap runs and drop covered own records in one task) |
| OwnOverRuns | `OwnQueue` over the installed runs in `get`, `range` and `view` |
| ViewPin | `ViewSnapshotImpl`, `Db.view`, the `OwnQueue` pin |
| CompactPreserve | `latestSstEntry`, `foldEntries` (TypeScript path of `mergeSsts`) |
| IngestPlan | `planIngest`, `planReclaim`, `checkCover`, `RECLAIM_LAG` (`host/queues.ts`) |

**Sync commit:** `2cfa2d5c856af8364d37431af6cf45e6e5361015`, confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- `update` across pages (last writer wins): only `tests/sim/multi-handle.test.ts` checks it.
- A corrupt log segment: the SharedWorker drops that log's records past the damage with only a console error (`tests/sim/corruption.test.ts` prints it).
- `pendingBytes` and the host's round triggers (`batchBytes`, `maxLatencyMs`). The checks do not model them.
