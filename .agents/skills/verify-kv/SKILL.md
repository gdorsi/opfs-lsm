---
name: verify-kv
description: "Formally check @opfs-lsm/kv core promises: WAL ack visibility across ingest, WAL-over-SST reads, view pins, compaction merge, updates that lose nothing, and power-loss recovery. Use when changing ingest, WAL, pointGet, view snapshots, SST merge/compaction, update, reclaim, recovery (reconcile/adopt), or any bug where get/view can disagree with a successful put."
---

# Verify @opfs-lsm/kv (formal suite)

## Properties

| Id | Property (plain) | Harm if broken |
|---|---|---|
| **NoLostAcks** | After WAL `put`/`batch` ack, `get` still sees the value until a later write supersedes it — including across `ingestChunk`. | Client saw success; later `get` misses because `advanceIngested` beat `publishGeneration`. |
| **WalOverSst** | Uningested WAL wins over SST (including tombstones), and a newer level over an older one, also on a cold get. | Stale SST value or resurrected key after delete. |
| **ViewPin** | `view()` / `ViewSnapshotImpl` get ignores WAL appends after the pin. | Snapshot is not stable mid-callback. |
| **CompactPreserve** | Newest-first SST merge / compaction keeps the same per-key visible entry as layered get, also over a run below the merge (a delete drops only in a bottom merge), also when it drops the winners its base marks cover, for reads at or past its install whose marks may have retired. | Compact drops or resurrects keys. |
| **UpdateExact** | The body of every `update` row that has its ops read the state just before that row's seq, whichever way the appends, commits and landings of two tabs interleave. A row that took another seq than the one its header names has no ops for every reader, its writer included, so each tab's memtable stays one log prefix (PrefixExact). An update that resolved wrote a row that has its ops (AckedInLog), its body ran at most twice, and every update resolves. A put or an update resolves with its tab's memtable at or past its seq (ReadYourWrites). | A lost update: two increments read the same value. Or one tab reads a write that no other reader has, or misses a write of its own that resolved. |
| **ReclaimHold** | A run a tab holds open, for its installed generation or for an open view, stays on disk, and a load that holds the reclaim lock finds every file of the generation it read, whichever way the tab's steps and the host's removals interleave. | A read or a view fails on a file the host removed, or a healthy database counts toward `CorruptDatabaseError`. |
| **PowerPrefix** | After any power loss (the WAL database, the `opfs-lsm-destroyed` row and OPFS each keep a prefix of their own writes, unordered, except that a strict write precedes every later one), the database opens and reads the state after one log prefix (a destroy or a `destroyDb` is an entry that deletes every write before it, and once any op after its strict commit survives, the read is from after it: DestroyHolds); a process crash keeps every acked write; recovery leaves a healthy database, with the head at or past every seq a manifest on disk names (HeadPast). No power-loss state is refused as corrupt; a missing run of the recorded manifest is refused with nothing written, unless a manifest holding every ingested seq stands in (CorruptRefuse). From every crash state, `destroyDb` leaves no WAL database and no file, and an open after it reads empty (RemoveClean). After every recovery and a flush, losing only the WAL database changes no read (WalLost). | Database will not open, reads a state no prefix of the log produced, recovery drops data still on disk, or rows `destroyDb` removed come back. |
| **CrashTable** | One power loss takes no more than the power-loss table of design.md, "Crash behavior", says. The open reads every append IndexedDB kept, unless OPFS lost the files of more than one flush whose commit IndexedDB kept (FlushKept). It reads every write of a manifest that OPFS kept with all its runs, whatever IndexedDB lost (ManifestKept). | A power loss takes acked writes that the two stores together still held. PowerPrefix passes it: the empty prefix is a prefix. |

## When to run

| Change touches | Run |
|---|---|
| `host/ingest.ts`, `idb/wal.ts` (`listUningested`, `advanceIngested`) | full suite (or at least `formal:ingest-visibility` and `formal:crash-table`) |
| `store/read.ts` `pointGet` / `latestSstEntry`, `keysReader`, `db.ts` `get` | `formal:wal-over-sst` + ingest |
| `view.ts` `ViewSnapshotImpl`, `db.ts` `view`, `store/memtable.ts` `pin` | `formal:view-pin` |
| `store/read.ts` `latestSstEntry`, the merge session (`packages/kv/engine/merge.ts`) and its oracle (`tests/oracle/merge-ts.ts`), `host/compact.ts`, `store/levels.ts` `planCompaction` (`bottom`) | `formal:compact-preserve` |
| `db.ts` `update` / `updateOnce`, `commit`, `landed`; `idb/wal.ts` `rowValid`, `encodeOps`, `decodeOps`, the head move of `adopt` | `formal:update-exact` |
| `db.ts` `retrying`, `load`, `release`, `view`; `holdingFiles` / `unlessHeld`; `BrowserReadFs.open`, `removeUnlessOpen`; `reclaimRuns`, `HostedDb.reclaim` / `sweepIdle` | `formal:reclaim-hold` |
| `recover.ts`, `idb/wal.ts` (`adopt`, `advanceIngested`), `host/ingest.ts`, `host/compact.ts` `installStep`, `HostedDb.reclaim` / `sweepIdle` / `fold`, `sweep`, `reclaimManifests` and the reclaim lock (`unlessHeld`), manifest numbering, `openDb` / `syncOnce` repair, destroy (`recordEmpty`, `emptyWal`, `HostedDb.destroy`, `destroyedTop` in rule 3), `destroyDb` (`destroy.ts`: `removeDatabase`, `openAlone`, `deleteWal`; `idb/destroyed.ts`, rule 0, `RemovableBrowserFs.removeFolder`), the host's opens (`IdBWal.openExisting`, `findBrowserFs`) | `formal:power-loss`, and `formal:crash-table` for the records a flush keeps (`advanceIngested`) and rules 1 and 3 of `reconcile` |
| Unknown / several areas | **`formal:kv`** (all) |

## Tool and why

Small exhaustive TypeScript checkers (BFS or full finite domains) plus source-sync guards where the model encodes product await/check order. No JVM — uses repo `tsx`/`pnpm`. Ingest step order is **parsed from** `ingest.ts`. View and compact checks also assert the relevant control flow still exists in source, so a missing `mem.pin()` copy, a reversed `latestSstEntry` loop, or a merge session that gives a tie to the older source fails the suite.

## Command

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Individual: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:update-exact`, `formal:reclaim-hold`, `formal:power-loss`, `formal:crash-table`.

Exit `0` = all selected checks pass. Failures print a shortest path (or counterexample inputs) in product words.

## Bounds (honest scope)

| Check | Bound |
|---|---|
| NoLostAcks | 1 key, ≤2 appends, one in-flight ingest; omits compact, multi-tab cache, crash. Reads see the new run from `publishGeneration` on, where tabs see it once `advanceIngested` records it. Must also catch 2 broken orders. |
| WalOverSst | 1 key; all WAL×SST hit kinds (`miss`/`tomb`/two values) and marks on **real** `pointGet` over one run; then two levels, every hit kind of each, each run cold, with its Bloom filter loaded, with its block loaded (a filter that never loads), or with both |
| ViewPin | The real `Memtable`, from a chunk one row short of a split, through every sequence of up to 5 writes (a put that overwrites, a put that inserts and splits, a put past the last key, a delete, a range delete, a generation install), a pin before each write; omits SST generation bump mid-view. Must also catch 3 broken pins. |
| CompactPreserve | ≤2 sources of one run, keys `{a,b}`, cell ∈ {miss, put1, put2, del}, and every one-run layout below the merge; marks: one key, three versions, a base mark and a mark flushed before the install, retirement per key; omits Bloom false negatives, reclaim races |
| UpdateExact | Two tabs, 1 key, ≤2 updates and ≤1 put each (`FORMAL_UPDATE_UPDATES`, `FORMAL_UPDATE_PUTS`), and one recovery that drops the WAL records. Every await is a step: an update's `warm` load (before the row and again before the transaction), a row joins a group commit, commits, lands; a tab applies one seq at a time. The key stands for every key a body reads, since they are read in one turn. Histories that differ only in what both tabs have applied are one state. One tab's own commits may take any order, which is more than IndexedDB allows. An update may take the transaction from the start at any time, so no property rests on the rule that picks it (an append of the handle in flight, or a row of the handle that lost). Omits flushes and generation loads, a read that waits for a page, a refused write, close, and more than one key. Must also catch 6 broken variants, five of them with no recovery. |
| ReclaimHold | One tab and one host: ≤3 installs (flush, compaction or destroy), 1 idle sweep, ≤3 syncs, ≤2 views (`FORMAL_RECLAIM_INSTALLS`, `FORMAL_RECLAIM_SYNCS`). Every file removal is a step. A destroy's two `unlessHeld` sections are one step; omits crashes, a second tab, a second attempt of the same tab at once, and the parallel order of a load's run opens. Must also catch 6 broken variants. |
| PowerPrefix | Workloads of ≤6 commands (`FORMAL_POWER_CMDS`): appends, ingests (of every waiting record or only the oldest, a flush chunk), compactions (alone or with a flush between the merge and the install), an ingest or a compaction whose IndexedDB commit fails on a host that goes on, sweeps with no install before them, destroys and removals (`destroyDb`, and the next command opens the database again). Workloads that write the same durable ops are checked once. Every (WAL database, row, OPFS) prefix triple, recovery then 4 more commands, and every triple of the next power loss, 2 deep (`FORMAL_POWER_CRASHES`). The next power loss also leaves each OPFS prefix with both IndexedDB databases thrown away, where only the log prefix is checked. A recursive OPFS removal is modeled in one order (manifests newest first, then runs). Writes are abstract ids, so values, folding and a row's header are not modeled, and a manifest records the writes its runs held, so a read over a run written again shows; one tab, one host, compaction merges every run of the base, every flush writes a run, and no file removal fails. Every workload runs with reclaim and again with a tab holding the reclaim lock (no removals). Tab-side retry liveness under the lock is not modeled (crash-enum churn tests). Must also catch 20 broken variants. RemoveClean runs `destroyDb` on every crash state. WalLost drops only the WAL database after each recovery and a flush. CorruptRefuse removes each run of the recorded manifest after every workload (with and without the lock). |
| CrashTable | The PowerPrefix model. Workloads of ≤6 appends/updates/ingests/compactions (`FORMAL_TABLE_CMDS`; an ingest folds every waiting record or only the oldest), every (WAL database, OPFS) prefix pair, one power loss, with reclaim and again with a tab holding the reclaim lock. Omits destroys and removals, whose rows DestroyHolds owns, and a second power loss. Must also catch 2 broken variants. |

A pass is for the model/domain above, not the whole browser stack (SharedWorker ports, IDB quirks, OPFS crashes).

## Reading failures

- **NoLostAcks:** path with `advanceIngested` before `publishGeneration` and model `resolveGet` undefined.
- **ViewPin:** the write sequence after which a pin reads another row, or other marks, than when it was taken; or `db.ts` no longer passes `this.mem.pin()` and `this.point()` into `ViewSnapshotImpl`. `model too weak` means a broken pin (one that shares the live chunk array or first keys, or leaves its chunks owned by the live table) passed.
- **CompactPreserve:** before/after merge disagree; or `read.ts` no longer gets newest-first, or `engine/merge.ts` / `tests/oracle/merge-ts.ts` no longer keep the newer source on a tie, or no longer drop a covered winner first, or drop a delete when not told to, or `compact.ts` stops claiming `base.through` or passing `plan.bottom` as `dropTombstones`, or `levels.ts` calls a plan bottom with a deeper run over its inputs. Three broken variants must be caught: a merge with a run below it dropping a delete, dropping a winner one seq past its mark, and an output claiming a mark flushed after its plan.
- **UpdateExact:** the shortest interleaving, one product step per line, then the property it breaks: a row with ops whose body read an older state (UpdateExact), a tab whose memtable is not the state after its `appliedThrough` (PrefixExact), an update that resolved on a row with no ops (AckedInLog), or a write that resolved with its tab's memtable behind its seq (ReadYourWrites). `source sync` names the decision in `db.ts` or `idb/wal.ts` that the model encodes and the code no longer makes.
- **ReclaimHold:** the shortest interleaving of tab and host steps, then the property it breaks: a held run removed (HeldStays, ViewHolds), or a locked load that found a file gone (LockedLoad).
- **PowerPrefix:** the first crash state (what each store kept), then each nested recovery crash, and the read that is not a prefix, the open that fails, the manifest that names a seq past the head, or the `checkDatabase`-style problem. `model too weak` means a broken variant passed: the model lost a behavior the product depends on. `source sync` names a product decision the model encodes that the code no longer makes.
- **CrashTable:** the workload, what the WAL database and OPFS kept, and the row it breaks: the appends IndexedDB kept that the open does not read (FlushKept), or the manifest on disk with its runs whose writes it does not read (ManifestKept).
- **Modeling error:** path impossible in TS, or parser/source-sync out of date — fix the formal files, do not weaken the property.

## Coverage record

| Check | Code |
|---|---|
| NoLostAcks | `ingestChunk` order: `publishL0`, `publishGeneration`, `advanceIngested` |
| WalOverSst | `pointGet`, and `latestSstEntry` under it: a level read without its Bloom filter is walked past, and its miss still answers before an older level's hit |
| ViewPin | `Memtable.pin`, `apply` and `advanceTo` run for real; `DbImpl.view` handing `ViewSnapshotImpl` the pin and the read point it took then (regex guard in `formal/view-pin/check.ts`) |
| CompactPreserve | `latestSstEntry`, the pick of the merge session and its oracle (`before` in `engine/merge.ts`, `Session.run` in `tests/oracle/merge-ts.ts`), the covered-winner drop (`nextKey`, `Session.emit`) and the mark test of `covered` (a mark holds a key from its start to its end exclusive, the highest `through` judges), the delete drop under `dropTombstones` in both, `plan.bottom` passed as `dropTombstones` in `writeStep` and set in `planCompaction` only when no deeper run overlaps the inputs, the claim in `mergeNextStep` |
| UpdateExact | `rowValid`; `decodeOps` reading the header from the first byte only and giving the ops by `rowValid` after it parsed the whole row; its call sites (the tail read, the flush read, a BroadcastChannel row); `DbImpl.commit` landing its own row by `rowValid`; `warm` naming its load by the `appliedThrough` it starts reading at, and `plan` reading that load only while `appliedThrough` has not moved, else the memtable; the stretch of `updateOnce` with no await (the read, `body`, `appliedThrough + 1`, the append), which resolves only when `rowValid` holds and runs `write` otherwise, and which no update enters with an append of its handle in flight (`appending`) or after a row of the handle lost (`beaten`); the transaction in `write` catching the memtable up to the tail before `plan`; the chain in `update`; `landed` catching the memtable up before a row with ops that lands past a gap resolves, and waiting for no catch-up on a row with no ops; `adopt` moving the head when it drops the records (regex guards in `formal/update-exact/check.ts`) |
| ReclaimHold | `retrying` taking the reclaim lock from the second attempt, before the tail read; `BrowserReadFs.open` taking the run lock before `getFile`; `view` retaining the installed layers; every host removal under `unlessHeld`, and runs only through `removeUnlessOpen` |
| PowerPrefix | `reconcile`, `IdBWal.adopt`, `advanceIngested` retention, `ingestChunk` and `installStep` building on the recorded generation and numbering past `top`, `HostedDb.reclaim` and `fold` removing files only under `unlessHeld`, `sweep` keeping the runs of every manifest numbered past the recorded one, `sweepIdle` sweeping only for the generation the host last checked, a flush or an install whose commit fails removing no file and leaving that generation, `installStep` removing none, destroy committing generation 0 past every seq at strict durability before it removes a file, recovery skipping manifests up to `destroyedTop`, `openDb` and `syncOnce` repair under `holdingFiles`, `reconcile` refusing a recorded manifest that does not decode or lists a gone run (`formal/power-loss/model.ts`, regex guards in `check.ts`), the head as `headOf` finds it (`ingestedThrough` when no record is at `ingestedThrough + 1`, else the last WAL key), appends taking the seq of the key generator, adopt and destroy moving that generator with the head (`passKeyGenerator`), and an adopt that drops the records moving the head by at least one (a regex guard only: the model has one tab, and `tests/sim/corruption.test.ts` covers the open handle that must follow), `removeDatabase`'s order (the fence at one version up, the strict empty commit, the strict row that never moves down, `m/` then the folder, the WAL database deletion last), rule 0's strict birth past the row before `forgetDestroyed`, and at the row's own figures when a manifest past its `top` shows a database born after it, `floorOfFiles` with no WAL database, and a host that opens only existing stores (`openExisting`, `findBrowserFs`) |
| CrashTable | `advanceIngested` deleting the records at or below the previous `ingestedThrough` and keeping the ones it folds, rule 1 of `reconcile` recording an intact manifest past the head, rule 3 falling back to the newest intact manifest, and `adopt` keeping the WAL records that follow the manifest it records (`formal/power-loss/model.ts`. Its regex guards are in `formal/power-loss/check.ts`, so run `formal:power-loss` for source sync. No guard names `follows` in `adopt`: `tests/recover.test.ts` holds it) |

**Sync commit:** `c2199a28e0f66fc2dee92e9c316ce7a8163c0071` — confirmed against the symbols above. Move forward only after `formal:kv` passes and models still match.

## Intentional product change

1. Edit product code.
2. Update the matching files under `packages/kv/formal/`.
3. `pnpm --filter @opfs-lsm/kv formal:kv`
4. Set **Sync commit** to `git rev-parse HEAD`.

Drift without recheck → `/maintain-formal-verification-skill`.

## Not covered yet (next targets)

- Multi-tab BroadcastChannel versus an SST generation bump, and `changes()`. No model: `tests/sim/tab-follow.test.ts` runs every short command sequence on two real handles instead (docs/verification.md, "Run the unit tests").
- A flush whose records leave no entry, which publishes a manifest and no run, and a file removal that fails, under power loss. In PowerPrefix every flush writes a run and every removal succeeds.
- A broken variant for WalOverSst. The check does not show that it can fail.
- `pendingBytes` in `EngineHost` (the ingest trigger), and a tab's head lookup past its own `appliedThrough`. The checks do not model them.
- A tab's generation installs: the open's load, which `boot` waits for before its fallback sync, against a load or repair that installs another generation. No check or unit test fails when `boot` stops waiting.
