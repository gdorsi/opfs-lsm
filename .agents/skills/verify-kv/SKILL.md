---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: WAL ack visibility across ingest, WAL-over-SST reads, view pins, compaction merge, and power-loss recovery. Use when changing ingest, WAL, pointGet, view snapshots, SST merge/compaction, reclaim, recovery (reconcile/adopt), or any bug where get/view can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put`/`batch` ack, `get` still sees the value until a later write supersedes it — including across `ingestChunk`. | Client saw success; later `get` misses because `advanceIngested` beat `publishGeneration`. |
| **WalOverSst** | Uningested WAL wins over SST (including tombstones). | Stale SST value or resurrected key after delete. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores WAL appends after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get, also when it drops the winners its base marks cover, for reads at or past its install whose marks may have retired. | Compact drops or resurrects keys. |
| **PowerPrefix** | After any power loss (the WAL database, the `opfs-lsm-destroyed` row and OPFS each keep a prefix of their own writes, unordered, except that a strict write precedes every later one), the database opens and reads the state after one log prefix (a destroy or a `destroyDb` is an entry that deletes every write before it, and once any op after its strict commit survives, the read is from after it: DestroyHolds); a process crash keeps every acked write; recovery leaves a healthy database. No power-loss state is refused as corrupt; a missing run of the recorded manifest is refused with nothing written, unless a manifest holding every ingested seq stands in (CorruptRefuse). From every crash state, `destroyDb` leaves no WAL database and no file, and an open after it reads empty (RemoveClean). After every recovery and a flush, losing only the WAL database changes no read (WalLost). | Database will not open, reads a state no prefix of the log produced, recovery drops data still on disk, or rows `destroyDb` removed come back. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`) | full suite (or at least `formal:ingest-visibility`) |
| `store/read.ts` `pointGet`, `db.ts` `readKey` / `get` | `formal:wal-over-sst` + ingest |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, `store/memtable.ts` `pin` | `formal:view-pin` |
| `store/read.ts` `latestSstEntry`, the merge session (`crates/engine-core/src/merge.rs`) and its oracle (`tests/oracle/merge-ts.ts`), `host/compact.ts` | `formal:compact-preserve` |
| `recover.ts`, `idb/wal.ts` (`adopt`, `advanceIngested`), `host/ingest.ts`, `host/compact.ts` `installStep`, `HostedDb.reclaim` / `fold` and the reclaim lock (`unlessHeld`), manifest numbering, `openDb` / `syncOnce` repair, destroy (`recordEmpty`, `emptyWal`, `HostedDb.destroy`, `destroyedTop` in rule 3), `destroyDb` (`destroy.ts`: `removeDatabase`, `openAlone`, `deleteWal`; `idb/destroyed.ts`, rule 0, `RemovableBrowserFs.removeFolder`), the host's opens (`IdBWal.openExisting`, `findBrowserFs`) | `formal:power-loss` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await/check order. No JVM — uses repo `tsx`/`pnpm`. Ingest step order is **parsed from** `ingest.ts`. View and compact checks also assert the relevant control flow still exists in source, so a missing `mem.pin()` copy, a reversed `latestSstEntry` loop, or a merge session that gives a tie to the older source fails the suite.

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
| CompactPreserve | ≤2 sources of one run, keys `{a,b}`, cell ∈ {miss, put1, put2, del}; marks: one key, three versions, a base mark and a mark flushed before the install, retirement per key; omits Bloom false negatives, reclaim races |
| PowerPrefix | Workloads of ≤6 appends/ingests/compactions/destroys/removals (`FORMAL_POWER_CMDS`; an ingest folds every waiting record or only the oldest, a flush chunk; a removal is `destroyDb`, and the next command opens the database again), every (WAL database, row, OPFS) prefix triple, recovery then 4 more commands, and every triple of the next power loss, 2 deep (`FORMAL_POWER_CRASHES`). A recursive OPFS removal is modeled in one order (manifests newest first, then runs). Writes are abstract ids, so values and folding are not modeled; one tab, one host, compaction merges every run of the base. Every workload runs with reclaim and again with a tab holding the reclaim lock (no removals). Tab-side retry liveness under the lock is not modeled (crash-enum churn tests). Must also catch 17 broken variants. RemoveClean runs `destroyDb` on every crash state. WalLost drops only the WAL database after each recovery and a flush. CorruptRefuse removes each run of the recorded manifest after every workload (with and without the lock). |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks:** path with `advanceIngested` before `publishGeneration` and model `resolveGet` undefined.
- **ViewPin:** `view.get` sees a post-pin append; or `db.ts` no longer passes `this.mem.pin()` into `ViewSnapshotImpl`, or `memtable.ts` drops the copy-on-write pin.
- **CompactPreserve:** before/after merge disagree; or `read.ts` no longer gets newest-first, or `merge.rs` / `tests/oracle/merge-ts.ts` no longer keep the newer source on a tie, or no longer drop a covered winner first, or `compact.ts` stops claiming `base.through`. Two broken mark variants must be caught: dropping a winner one seq past its mark, and an output claiming a mark flushed after its plan.
- **PowerPrefix:** the first crash state (what each store kept), then each nested recovery crash, and the read that is not a prefix, the open that fails, or the `checkDatabase`-style problem. `model too weak` means a broken variant passed: the model lost a behavior the product depends on. `source sync` names a product decision the model encodes that the code no longer makes.
- **Modeling error:** path impossible in TS, or parser/source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestChunk` order: `publishL0`, `publishGeneration`, `advanceIngested` |
| WalOverSst | `pointGet` |
| ViewPin | `ViewSnapshotImpl`, `Db.view`, `Memtable.pin` |
| CompactPreserve | `latestSstEntry`, the pick of the merge session and its oracle (`before` in `merge.rs`, `Session.run` in `tests/oracle/merge-ts.ts`), the covered-winner drop (`next_key`, `Session.emit`), the claim in `mergeNextStep` |
| PowerPrefix | `reconcile`, `IdBWal.adopt`, `advanceIngested` retention, `ingestChunk` and `installStep` building on the recorded generation and numbering past `top`, `HostedDb.reclaim` and `fold` removing files only under `unlessHeld`, `installStep` removing none, destroy committing generation 0 past every seq at strict durability before it removes a file, recovery skipping manifests up to `destroyedTop`, `openDb` and `syncOnce` repair under `holdingFiles`, `reconcile` refusing a recorded manifest that does not decode or lists a gone run (`formal/power-loss/model.ts`, regex guards in `check.ts`), the head as `headOf` finds it (`ingestedThrough` when no record is at `ingestedThrough + 1`, else the last WAL key), appends taking the seq of the key generator, adopt and destroy moving that generator with the head (`passKeyGenerator`), and an adopt that drops the records moving the head by at least one (a regex guard only: the model has one tab, and `tests/sim/corruption.test.ts` covers the open handle that must follow), `removeDatabase`'s order (the fence at one version up, the strict empty commit, the strict row that never moves down, `m/` then the folder, the WAL database deletion last), rule 0's strict birth past the row before `forgetDestroyed`, and at the row's own figures when a manifest past its `top` shows a database born after it, `floorOfFiles` with no WAL database, and a host that opens only existing stores (`openExisting`, `findBrowserFs`) |

**Sync commit:** `5f486a8d901839185f34d659a4a30d4d4e990c56` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- Multi-tab BroadcastChannel versus an SST generation bump.
- Compaction reclaim versus an open view pin (generation lifetime).
- `pendingBytes` in `EngineHost` (the ingest trigger), and a tab's head lookup past its own `appliedThrough`. The checks do not model them.
