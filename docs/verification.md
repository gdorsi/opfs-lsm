# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/docstore`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of WAL visibility, point get, view pins, SST merge, and power-loss recovery.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| WAL append or ack, `ingestChunk`, `listUningested`, `advanceIngested` | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility`, `formal:power-loss` and `formal:crash-table`) |
| The write order of ingest, compaction install or reclaim, `reconcile`, `IdBWal.adopt`, manifest numbering, or the open path | `formal:power-loss` and `formal:crash-table`, then `tests/sim/crash-enum.test.ts` with a long sweep (below) and `KV_CRASH_PAIRS=20` on `tests/sim/io-error-crash.test.ts`, then `power-loss-chrome` (see [Lose IndexedDB commits in real Chrome](#lose-indexeddb-commits-in-real-chrome)), then `kill-chrome --minutes 10` |
| `update`, the header of a WAL row (`rowValid`, `encodeOps`, `decodeOps`), or how a tab lands its own append (`commit`, `landed`) | `formal:update-exact`, then `tests/update.test.ts`, and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts`. A change to the row format also takes the decoder row below. |
| Generation loading in `db.ts` (`syncOnce`, `write`, `load`) or the reclaim lock (`holdingFiles`, `unlessHeld`) | `formal:reclaim-hold`, `formal:power-loss`, the churn tests in `tests/sim/crash-enum.test.ts`, and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts` |
| Point get versus SST, including tombstones (`pointGet`, `keysReader`) | `formal:wal-over-sst`. Add `drive bench kv/` when the OPFS read after ingest changed. |
| `view()` or the memtable pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, the merge session in `packages/kv/engine/merge.ts` and its oracle `tests/oracle/merge-ts.ts`, `host/compact.ts`, the `bottom` of `planCompaction`) | `formal:compact-preserve`, `pnpm --filter @opfs-lsm/kv test`, plus `drive bench kv/` for a real post-ingest get |
| `destroyDb`, the `opfs-lsm-destroyed` row, the open lock, recovery rule 0, or the host's opens that never create | `formal:power-loss`, then `tests/sim/crash-enum.test.ts` with a long sweep (below), then `KV_CLOSE_SEEDS=1000` on `tests/sim/close-random.test.ts` (`KV_CLOSE_FIRST=<seed> KV_CLOSE_SEEDS=1` replays a seed), then `drive destroy`, then `power-loss-chrome --destroy`, then `kill-chrome --minutes 10` |
| How a tab follows another: a BroadcastChannel row, `catchUp`, `follow`, a generation install that moves the memtable (`advance`), `changes()` (`applyRecord`, `announce`), or `dangerousDestroy` seen from a second handle | `KV_FOLLOW_DEPTH=4` on `tests/sim/tab-follow.test.ts`, `KV_INFLIGHT_SEEDS=400` on `tests/sim/in-flight-feed.test.ts` (`KV_INFLIGHT_FIRST=<seed> KV_INFLIGHT_SEEDS=1` replays a seed), and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts`. No formal model covers it. |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| `BrowserFs` (`createWritable`, removes, file locks), the SharedWorker port, or any Web Lock | `kill-chrome --minutes 10` (see [Kill real Chrome](#kill-real-chrome)) |
| `packages/automerge/src/index.ts`, or a kv change claimed to speed up Automerge | `drive bench automerge/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/yjs/src/index.ts`, or a kv change claimed to speed up Yjs | `drive bench yjs/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/tanstack-query/src/index.ts`, or a kv change claimed to speed up TanStack Query's persister | `pnpm --filter @opfs-lsm/tanstack-query test` and `drive bench tanstack-query/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. |
| In-page `EngineHost` | `drive two-tab-local`. |
| `reserveBytes`, `onStorageFull`, the reserve file, the storage-full offer or its Web Lock | `tests/reserve.test.ts`, `tests/reserve-step.test.ts`, `tests/wal-full.test.ts`, and `KV_WALFULL_SEEDS=400` on `tests/sim/wal-full-random.test.ts` (`KV_WALFULL_FIRST=<seed> KV_WALFULL_SEEDS=1` replays a seed), then `drive quota`. Add `formal:kv` when the WAL append changed. |
| `packages/docstore/src`, or a kv change claimed to speed up documents | `drive bench tracker/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/tanstack-db/src` | `pnpm --filter @opfs-lsm/tanstack-db test`, with `TSDB_DIFF_RUNS=2000` after a change to the planner or the on-demand run. For a performance claim, `drive bench tanstack/ tanstack-ondemand/ tanstack-live/` with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `examples/linearlite-tanstackdb` | `pnpm --filter @opfs-lsm/example-linearlite-tanstackdb test`, `check` and `build`. For a change to its reads, counts or sync, drive the app in a browser against a server seeded with 100k issues, in two tabs and offline. |
| `examples/notes-manager-automerge` | `pnpm --filter @opfs-lsm/example-notes-manager-automerge test`, `check` and `build`. For a change to the editor, the tree, the bodies or the UI, run the browser proof (`examples/notes-manager-automerge/DESIGN.md`, "Browser proof") with `agent-browser`. |
| `examples/whiteboard-yjs` | `pnpm --filter @opfs-lsm/example-whiteboard-yjs test`, `check` and `build`. For a change to `src/app`, drive the app in a browser (`dev`, port 4183): draw every shape kind, undo and redo, reload and compare `whiteboard.digest()`, Escape and blur mid-drag leave no undo step, two tabs converge, and `?fault=1` shows the error and recovers. For the render path, drag a shape on the 5,000 and 20,000 sample boards and read the frame intervals. |
| A decoder or the on-disk format: SST (`sst.ts`, `sst-reader.ts`, and the wasm engine in `packages/kv/engine`, whose merge session reads runs), manifest (`generation.ts`), WAL rows (`decodeOps`), or `recover.ts` | `pnpm test`, then each Jazzer.js target for 10 minutes (see [Fuzz the decoders](#fuzz-the-decoders)) |
| The wasm engine (`packages/kv/engine`) | `KV_ENGINE=checked pnpm --filter @opfs-lsm/kv test`, `pnpm --filter @opfs-lsm/kv engine:gate`, then `KV_ENGINE_CASES=3000` on `fuzz/engine-checked.test.ts` and each engine Jazzer.js target for 10 minutes (see [Check the engine](#check-the-engine)) |
| The engine's checks (`packages/kv/checked`) | `pnpm --filter @opfs-lsm/kv mutant-canary` |
| The ingest trigger (`pendingBytes`, the idle flush, the limit the tabs ask for) | `tests/ingest-policy.test.ts`, `tests/backpressure.test.ts` and `tests/port-ingest.test.ts`. No formal model covers it. |
| Any TypeScript behavior | `pnpm test` |
| Any TypeScript or JavaScript source, including a removed export | `pnpm static` (oxlint, then `fallow dead-code`) |

A performance claim in any row is accepted on this rule. State the mechanism of the win. Name a workload where the change should make no difference or lose, and run it too. Run the before and after on the default seed, then the same before and after on two other seeds the change was not developed on, with `--seed N`. On each seed the min–max ranges of before and after do not overlap, which `compare` reports as a difference. Compare only files on the same seed.

## Run the Chrome proofs

From the repo root, in this order:

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive <feature>
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

`<feature>` is one of `two-tab`, `two-tab-nobc`, `two-tab-local`, `quota`, `destroy`, `bench <selector…> [--size tiny|small|large] [--reps N] [--contenders a,b] [--seed N]` and `bench-smoke`. A selector is a family (`kv/`, `tracker/`, `tanstack-live/`, `automerge/`, `yjs/`, `tanstack-query/`) or one workload such as `kv/fillrandom`. Drive each feature that the table above names. Run `doctor` again after a drive that fails, then `cleanup`, before the next drive.

`launch` installs dependencies when `node_modules` is missing, builds `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/yjs` and `@opfs-lsm/automerge`, and runs `doctor`. A checkout with no `dist` fails the first `doctor` (`kv dist: MISSING`). `launch` is the repair.

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH` when set, otherwise `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, otherwise `google-chrome` on `PATH`), `packages/kv/wasm/engine.wasm`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/docstore/dist/index.js`, and `node_modules`.

The helper runs:

| Feature | Command |
| --- | --- |
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `quota` | `TWO_TAB_QUOTA=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `destroy` | `TWO_TAB_DESTROY=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `bench <selector…>` | `pnpm bench <selector…>`, with the flags after it |
| `bench-smoke` | `pnpm bench:smoke` |

A passing drive prints `drive: ok evidence=...` and exits 0. `exit_code.txt` is `0`. Stdout contains the proof strings:

| Feature | Proof strings |
| --- | --- |
| `two-tab` | `tabs=2`, `mode=SharedWorker`, `two-databases ok`, `two-tab ok` |
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-databases ok`, `two-tab ok`, and `bc_posts=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local EngineHost`, `two-databases ok`, `two-tab ok` |
| `quota` | `tabs=2`, `mode=SharedWorker`, `OPFS write is refused`, `storage full answered once, by tab`, `run files`, `the reserve file is back`, `no handler: one warning in each tab, no row lost`, `limit lifted: the reserve file is back`, `quota ok`. The `fill of a 24 MiB reserve` line times the fill. |
| `destroy` | `mode=SharedWorker`, `other tab closed reason=destroyed`, `other tab put and view read rejected with ClosedError`, `wal database gone`, `folder gone`, `reopened empty`, `never-opened left nothing`, `crashed tab: destroyDb finished`, `destroy ok`. The `frozen tab:` and `tab navigated away:` lines are facts about the Chrome it ran on: a frozen tab holds `destroyDb` until it resumes, and a page in the back/forward cache is evicted. |
| `bench`, `bench-smoke` | One `## <family>/<workload>: <title>` section per workload, a row per contender, and no `## Failed runs` section. Every read is checked against a model, so exit 0 means every value was right. |

Evidence stays after cleanup:

```text
.agents/skills/verify-opfs-lsm/artifacts/<feature>/<run-id>/
  meta.txt
  stdout.txt
  stderr.txt
  exit_code.txt
```

`VERIFY_OPFS_ARTIFACTS` overrides the root. `VERIFY_OPFS_RUN_ID` fixes the run folder name.

`cleanup` removes nothing, because every harness uses a fresh temp Chrome profile. It prints `cleanup: nothing to remove (each run uses a temp profile)` and `cleanup: artifacts preserved under ...`, and exits 0.

## Kill real Chrome

`packages/kv/scripts/kill-chrome.ts` kills Chrome under load and checks the database after a relaunch. MemoryFs and fake-indexeddb cannot show the platform facts the design leans on. This loop shows them on the Chrome it runs.

```sh
pnpm --filter @opfs-lsm/kv kill-chrome                         # the probes, then 20 iterations, random seed
pnpm --filter @opfs-lsm/kv kill-chrome --minutes 30 --keep-going
pnpm --filter @opfs-lsm/kv kill-chrome --seed <seed> --from <iteration> --iterations 1 --kinds <kind> --no-probes   # replay
pnpm --filter @opfs-lsm/kv kill-chrome --probes-only
pnpm --filter @opfs-lsm/kv kill-chrome --inspect <db> --profile <kept profile> --port <port>   # dump a kept database's files
```

Each iteration opens 2 or 3 tabs on one database, on one Chrome profile. Each tab runs a seeded workload of puts, deletes and batches over 192 keys with `maxWalBytes` of 1, 4 or 16 KiB, so the SharedWorker ingests and compacts many times a second. A tab has one write in flight at a time. It reports each ack (attempt and seq) over a CDP binding as soon as the ack resolves. The workload is a function of (seed, iteration, tab), so the harness can regenerate every attempt a tab made. At a seeded time the harness does one of these, in turn:

| Kind | What it does |
| --- | --- |
| `page-crash` | `Page.crash` on one tab |
| `close-worker` | `Target.closeTarget` on the SharedWorker |
| `kill-renderer` | `kill -9` of one renderer process (a tab, the SharedWorker, or both) |
| `kill-browser` | `kill -9` of the browser process |
| `browser-crash` | `Browser.crash` |
| `quota` | `Storage.overrideQuotaForOrigin` at or just above the usage, `ingest()` from a tab, the quota restored, `ingest()` again |

After the browser process dies, the harness waits up to 10 s for Chrome's helpers (the storage service among them) to exit on their own before it kills what is left, so it never kills the storage service mid-write by itself.

When Chrome survives the kill, the other tabs finish their write in flight and close. Then every Web Lock whose name starts with `opfs-lsm` must come free within 20 s, and a new tab must open the database and `ingest()` through a SharedWorker. Chrome is then closed and relaunched on the same profile. A fresh tab opens the database, which runs recovery. It runs `checkDatabase` while holding the compaction and ingest locks (in the host's order), so no ingest, compaction or reclaim runs during the check. Then it reads the whole range and `get`s every key. It writes once, `ingest()`s through the new SharedWorker, and checks again.

A pass means all of these hold:

- The database opens, and `checkDatabase` reports no problem, before and after the ingest.
- `range()` and every `get` equal the state `checkDatabase` folds from the files.
- No ack is lost: every seq the harness saw acked is at or below the recovered `head`.
- The state is the fold of the log through `head`. Seqs the harness saw acked hold their own writes. Every other seq up to `head` holds an attempt a killed tab had in flight, in that tab's order, after its last seen ack. The harness tries every such assignment (`verify` in the script) and needs one whose fold equals the read state.
- After the restarted SharedWorker ingests, the state is unchanged apart from the new write, `head` moved by one, and the generation went up.

A process kill is not a power loss, so this is the stronger of the two crash levels in the research note: acked writes survive. The database persists across iterations, so later kills hit a database that earlier kills already crashed. It is replaced every 8 iterations (`--rotate`) and after a failure.

Before the loop, four probes check single facts:

| Probe | Pass |
| --- | --- |
| `tab-locks` | A tab holds the reclaim lock (shared), a run lock (shared) and the ingest lock. After `Page.crash`, another tab gets each one at once. |
| `worker-locks` | The SharedWorker takes the ingest and compaction locks (through a DevTools `Runtime.evaluate`). `Target.closeTarget` removes it from `Target.getTargets`. Both locks come free, and a new tab gets a new SharedWorker that ingests, both while the old client tab is still open and after it closed. |
| `writable-tab-crash` | A tab writes 64 KiB to a file and closes the writer, then writes 8 MiB through a second `createWritable` without closing it. After `Page.crash`, the file still holds the first 64 KiB. |
| `writable-browser-kill` | The same, with `kill -9` of the browser and a relaunch. |

Before the workload, under the quota and around the check, the loop lists the origin's IndexedDB databases and notes any that vanished, or an `indexedDB.open` that failed.

On failure the loop prints the seed, the iteration, the kind, the kill time, the reason and a replay command, writes the evidence (plan, failure, notes, harness log, Chrome stderr) to `--artifacts` (default `$TMPDIR/opfs-kill-chrome`), keeps the profile, and exits 1. Real Chrome does not replay a schedule, so a replay runs the same workload, kind and kill time, not the same interleaving. Run it a few times. A summary at the end prints the iterations per kind, the most orphans and swap files seen, and the errors `ingest()` gave under quota.

What the loop showed on Chrome 156 on macOS (CI runs it on Linux):

- An IndexedDB commit that fired `complete` survives `Page.crash`, `kill -9` of a renderer or of the browser, and `Browser.crash`, unless Chrome then throws away its whole IndexedDB store (below).
- An OPFS `createWritable` that a tab or the browser abandons leaves the target file as it was, and recovery opens every state these kills leave.
- Web Locks of a crashed tab and of a closed SharedWorker are released at once.
- `Target.closeTarget` closes a SharedWorker. A new tab gets a new one, and it ingests.
- `Storage.overrideQuotaForOrigin` makes OPFS writes fail. Ingest fails with `StorageFullError`, the database stays clean, and ingest works again once the quota is back. Any other error under the quota fails the iteration.

What it does not show:

- Power loss. A process kill keeps whatever reached the OS, so the loop never sees a write lost after its ack, or IndexedDB and OPFS reaching disk out of order. `crash-enum.test.ts` and `formal:power-loss` model that, and `power-loss-chrome` makes some of those states in real Chrome (below). The loop cannot.
- Unacked writes. A write the harness never saw acked may be in the log or not. Losing one is allowed, so the loop cannot tell a lost unacked write from one that never committed.
- Interleavings it does not hit. Kill times are seeded, but scheduling inside Chrome is not.
- Quota on IndexedDB. Chrome 156 applies `Storage.overrideQuotaForOrigin` to OPFS writes only. IndexedDB commits and `navigator.storage.estimate()` ignore it, so a WAL append never meets a quota error here.
- Other browsers.

Four behaviours it found:

- After `kill -9` of the browser or `Browser.crash`, Chrome sometimes damages its own IndexedDB store for the origin: the LevelDB directory gets a `corruption_info.json` ("Internal error opening backing store for indexedDB.open.") and `CURRENT` names a `MANIFEST` file that is gone. In 13 of 149 browser kills, a later launch failed `indexedDB.open` with that `UnknownError`, and then Chrome deleted every IndexedDB database of the origin. OPFS was untouched. Once, Chrome kept failing every `indexedDB.open` on that profile for the rest of the run instead. To the engine a deleted WAL is an IndexedDB power loss: recovery records the newest intact manifest and moves `head` past it, so the database is a log prefix and only the WAL tail is lost. Every such iteration since the harness drains Chrome's helpers passed. Two iterations from before the drain lost data after such a wipe, and are not explained (research note, "Phase 5 results"). An `openDb` that meets the failed open rejects with `StorageUnavailableError`, and the `UnknownError` is its `cause`.

- After `kill -9` of the browser mid-`createWritable`, the writer's swap file stays in OPFS as `<name>.crswap`, visible to directory listings. Chrome does not remove it after a relaunch. In a level directory, reclaim takes it for an orphan run and removes it. In `m/`, manifest reclaim removes it once the recorded generation reaches its number, which is the next flush. A swap file numbered past the recorded generation can belong to a write in progress, so it stays. `checkDatabase` lists these as `swapFiles`, not as problems. The loop prints `swap files in the database directory` when it sees one, and the summary prints the most it saw.
- While DevTools is attached to the SharedWorker, a tab that opens the database after `Target.closeTarget` gets no working SharedWorker, and its `ingest()` never settles. Detached, a new one starts. The `worker-locks` probe detaches before it closes the worker.
- Under the OPFS quota, `ingest()` rejects in the tab with `StorageFullError` (code `quota`), whose message is Chrome's `QuotaExceededError` text. The host maps the `QuotaExceededError` name to the code before the reply (`codeOfError`).

## Lose IndexedDB commits in real Chrome

`packages/kv/scripts/power-loss-chrome.ts` makes by hand the state a power loss leaves when OPFS reached the disk and the newest IndexedDB commits did not. While Chrome runs, it copies the IndexedDB directory of the profile. After Chrome quits, the copy replaces the directory, and OPFS keeps its newer files. Then it relaunches and opens the database.

```sh
pnpm --filter @opfs-lsm/kv power-loss-chrome            # five scenarios, under a minute
pnpm --filter @opfs-lsm/kv power-loss-chrome --verbose  # also print the WAL keys and ingestedThrough at each step
pnpm --filter @opfs-lsm/kv power-loss-chrome --destroy  # OPFS loses the removes of destroyDb instead
```

Exit 0 and a last line `power-loss-chrome ok (5 scenarios)`. Each scenario checks that:

- the relaunched Chrome reads the copy (the loss happened);
- the open reads a prefix of the writes, at least the ones the kept flush holds;
- a `put` after the open takes a seq past `ingestedThrough` and every WAL key, and is read back in that tab and after a restart.

The scenarios lose the newest records, every record, or the commit of a second flush, and two of them lose the recovery itself a second time. The key generator of `wal` is in the copied directory, so it goes back with the records. That is the fact fake-indexeddb can only model: an adopt that does not move the key generator fails all five, because the put takes a seq already in use (`the put took seq 8, at or below 20` in the first).

With `--destroy`, OPFS is the store that goes back. It copies the OPFS directory with Chrome quit, runs `destroyDb`, and puts the copy back, so the folder returns with its manifest and runs while IndexedDB keeps the deletion of the WAL database and the destroyed row. Exit 0 prints `destroyed rows stayed gone` and `power-loss-chrome ok (1 scenarios)`: the open reads none of the 25 removed keys, and a `put` takes a seq past every seq the removed database used. Recovery that skips rule 0 fails it, with `the open reads 20 writes`, the rows of the old manifest.

What it does not show: a real power cut. The copy is a whole, consistent directory, and OPFS loses nothing. Every pair of prefixes of the two stores is covered by `crash-enum.test.ts` and `formal:power-loss`, on models of the stores.

## Run on an Android device

Run this for a claim about Android, or after a change to the SharedWorker, `BrowserFs` or a Web Lock that a phone could treat differently from desktop Chrome. The device needs USB debugging. Unlock it when you will read the timings: a locked phone passes and fails the same, but runs the browser on its background CPU set.

```sh
node docs/research/android-device-run/run.mjs --install-chromium
```

The script installs the Chromium snapshot when the device has no `org.chromium.chrome`, then runs the probe, the three two-tab proofs, `bench smoke`, `bench run kv/` at 100,000 entries, and `kill-chrome`, each through a stand-in for the Chrome binary that drives the device over adb. A pass prints `all 8 steps passed` and exits 0. Logs land in `docs/research/android-device-run/results/<time>/`.

- The `kill` step leaves out `page-crash` and `kill-renderer`, which the harness cannot observe on Android.
- On a locked phone the `kill` step can fail on its `quota` kind with `ingest timed out after 20000ms`. [android-device-run.md](research/android-device-run.md) records that finding. It is not a new regression.
- To run one harness, or to use another browser, see [the tools' README](research/android-device-run/README.md).

## Run the formal suite

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Exit 0. The log ends with `All 8 formal checks passed`. Each check prints a `PASS` line:

- `PASS NoLostAcks`, after two `broken variant caught` lines (orders that record the flush before its manifest is on disk)
- `PASS WalOverSst` (on real `pointGet`: every memtable row, run and mark, then every pair of levels with each run cold, with its Bloom filter loaded, with its block loaded, or with both)
- `PASS ViewPin` (on the real `Memtable`: through every short sequence of writes, a pin taken before each write reads the rows and marks it read when taken), after three `broken variant caught` lines
- `PASS CompactPreserve` (`latestSstEntry` newest-first, both merge sessions give a tie to the newer source and drop a covered winner, a delete drops only in a bottom merge, outputs claim the base manifest's marks only), after three `broken variant caught` lines
- `PASS UpdateExact` (every interleaving of two tabs that update and put one key, with one recovery that drops the WAL records: each update row that has its ops was written from the state just before its seq, each memtable is a log prefix, and a put or an update resolves with its tab's memtable at or past its seq), after six `broken variant caught` lines
- `PASS ReclaimHold` (every interleaving of one tab that syncs and opens views with one host that flushes, compacts, destroys and sweeps, each file removal a step of its own: a run the tab or a view holds open stays on disk, and a load under the reclaim lock finds every file). Before it, six `broken variant caught` lines
- `PASS PowerPrefix` (every power-loss crash state, two power losses deep, recovers to a log prefix). Before it, twenty `broken variant caught` lines show the model fails each known wrong design. The model holds the key generator of `wal`, so a crash state that loses commits also loses what they did to it. It keeps the WAL database, the `opfs-lsm-destroyed` row and OPFS as three stores with no order between them. At the second power loss, each OPFS prefix with both IndexedDB databases thrown away is a crash state too. After each open and each step of a recovery, the head is at or past every seq a manifest on disk names.
- `PASS RemoveClean` (`destroyDb` from every crash state leaves no WAL database and no file, and an open after it reads empty)
- `PASS WalLost` (after every recovery and a flush, losing only the WAL database changes no read: a row a crash left behind never empties a database born after it)
- `PASS CorruptRefuse` (a run of the recorded manifest removed after every workload: open refuses and nothing writes, unless a manifest that holds every ingested seq stands in)
- `PASS CrashTable` (how much one power loss may take, on the model of PowerPrefix: the open reads every append IndexedDB kept unless OPFS lost the files of more than one flush it recorded, and every write of a manifest OPFS kept with all its runs, as the power-loss table of design.md, "Crash behavior", says), after two `broken variant caught` lines, each with its counterexample

The same checks have their own scripts: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:update-exact`, `formal:reclaim-hold`, `formal:power-loss`, `formal:crash-table`. `formal:power-loss` runs every workload twice: with reclaim, and with a tab holding the reclaim lock throughout, so the host removes no manifest or run. Its workloads mix appends, ingests, compactions, a flush during a merge, a flush or an install whose IndexedDB commit fails on a host that goes on, sweeps, destroys and `destroyDb` removals, and it checks each distinct list of durable ops once. `FORMAL_POWER_CMDS` (default 6) and `FORMAL_POWER_CRASHES` (default 2) widen the power-loss bound; the default bound takes about two minutes. `formal:crash-table` runs the same workloads without destroys and removals, one power loss deep, and `FORMAL_TABLE_CMDS` (default 6) widens it. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `8dadba6aca64ea43bfc4c86e85c7a9d3eafa95aa`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

`pendingBytes` is outside the model. A pass says nothing about the ingest trigger, which the unit tests check (see [Pick the check](#pick-the-check)).

## Run the unit tests

```sh
pnpm test
```

Exit 0. The root script checks that `README.md` still contains its required phrases and builds the six packages. Then it runs the unit suites of `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/yjs`, `@opfs-lsm/automerge`, `@opfs-lsm/tanstack-db` and `@opfs-lsm/tanstack-query` (`test:suites`) while it builds the example apps (`test:examples`). A failure in either fails the command.

The kv suite includes a model-based test (`packages/kv/tests/sim/model.test.ts`): random histories of writes, reads, views, ingests, compactions and reopens on one handle, checked against a log-prefix oracle, with `checkDatabase` (`tests/sim/check-database.ts`) walking the WAL, manifest and runs after every run. It runs 100 + 25 histories by default. For a longer sweep, or to replay a failure from the seed, path and `replayPath` it prints:

```sh
cd packages/kv
KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/model.test.ts
KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/model.test.ts
```

`tests/sim/multi-handle.test.ts` does the same over three handles that share one host, one MemoryFs and one fake-indexeddb, with handles opening and closing. Ops of different handles overlap, and an `fc.scheduler` picks the order of BroadcastChannel deliveries (which can also be dropped), file calls and pauses inside views and ranges (`tests/sim/multi.ts`). No row waits on a timer there: every second session posts each row as it lands, and the others post their first row and keep the rest until they close, so one message carries many rows. The recorded history is checked seq-exactly by `tests/sim/history.ts`: every read is a log prefix, each handle's prefix never goes back, read-your-writes at ack, `sync()` and open are barriers, a view reads one prefix, and an `update` reads exactly the state before its own seq, so concurrent increments lose nothing. The row of an update that another write beat is in the history as a commit with no ops, and the update's commit is the row that has them. It does not check that a handle sees another handle's write without `sync()`, because the design does not promise it. It runs 100 + 100 histories by default (a few seconds) and takes the same `KV_MODEL_*` variables; `KV_SIM_TRACE=1` prints every scheduled task and op. A command stalls a handle's run opens, so a slow catch-up can finish after a newer generation was installed. The harness runs each Web Lock callback in the async context of its requester: Node runs a queued one in the context of whoever released the lock, which would credit a commit to the wrong op.

`tests/sim/change-feed.test.ts` keeps a copy of the database from `changes()` alone, plus a view at each `gap`, on three handles (one without BroadcastChannel) under random writes, updates, flushes, `dangerousDestroy` and reopens, and checks that each copy equals what its handle reads and that each `update` record extends the value before it. It runs 40 seeds of 60 steps (about 2 s); `KV_FEED_SEEDS` and `KV_FEED_STEPS` lengthen it.

`tests/sim/tab-follow.test.ts` runs every sequence of up to 3 commands on two handles of one database, on the real `Db`, host and WAL. The commands are a put from either handle, a range delete of everything, `dangerousDestroy`, `sync`, a flush, an `update`, a view held open across later commands, a reopen, and `deliver`. BroadcastChannel is a queue that only `deliver` empties, so one handle lags the other until it hears or syncs. Each sequence runs from an empty database and from one whose first write both handles installed from a run: 2,750 sequences, about 20 s. After every command, each handle's view, `get`, `range` and `count` read the fold of the log through `snap.seq`, with a destroy as one entry that deletes every key. An `update` read the state just before its seq, a held view reads at its close what it read at its start, and the handle's `changes()` events name every applied seq once and in order, never before the handle reads it, and rebuild what the handle reads. Five wrong designs patched onto the `Db` must each fail. `KV_FOLLOW_DEPTH=4` runs 29,328 sequences (2 to 4 minutes). A failure prints its sequence, and `KV_FOLLOW_SEQ` replays it:

```sh
cd packages/kv
KV_FOLLOW_DEPTH=4 pnpm exec vitest run tests/sim/tab-follow.test.ts
KV_FOLLOW_SEQ="A.put, flush, B.sync" pnpm exec vitest run tests/sim/tab-follow.test.ts
```

`tests/sim/crash-enum.test.ts` enumerates crash states. A workload runs once with every durable op traced: OPFS file creates, publishes and removes, with a folder removal as one remove per file (`tests/sim/fault-fs.ts`, an `AsyncFs` wrapper), and IndexedDB commits to the WAL database and to the database's row in `opfs-lsm-destroyed`, and deletions of the WAL database, as one sequence, as Chrome keeps them in one LevelDB (`tests/sim/fault-wal.ts`, a wrapper on fake-indexeddb's object store and factory, with no product seam). Each crash state is rebuilt from a prefix of that trace, reopened, recovered by a fresh host, and checked with `checkDatabase` and the oracle. `destroyDb` on a copy of each crash state must leave no file and no WAL database. Two crash models:

- Process crash: one cut in the global order. The database must open and hold the whole committed log.
- Power loss: each store keeps its own prefix. The database must open and hold some log prefix (design.md, "Recovery"), at or past every destroy or removal one of whose removes OPFS kept. The fixed workloads check that floor. The random histories record no destroy, so they check the prefix alone. Every pair is checked, except the ones that keep an OPFS op after a strict IndexedDB commit and lose that commit, which no power loss leaves.

It covers seven fixed workloads (ingest, compaction with reclaim, a two-step cascade, two destroys over runs and a WAL tail, two `destroyDb` removals over the same, a `destroyDb` of a folder whose WAL database the browser threw away, and range deletes), every pair of each, and 15 random single-handle histories, which include removals, with 40 sampled pairs each by default (about 35 s). Use `KV_CRASH_RUNS` and `KV_CRASH_PAIRS` for a longer sweep, `KV_CRASH_REPORT=1` to print how many states were checked, and the `KV_MODEL_*` variables to replay. A change to the write order or recovery should pass `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` (about 7 minutes).

The same file holds the churn tests: a tab whose run opens are slow while the host flushes and compacts before each one returns, a tab whose every file call is preceded by four flushes and a compaction, for 40 syncs, and a tab that keeps the reclaim lock while the host flushes and compacts. A healthy database must never report `CorruptDatabaseError`, and the host must never wait for the tab (design.md, "Loading a generation under churn").

`tests/sim/io-error.test.ts` fails fault site N for N = 1, 2, … until a run reaches no site N, with one-shot and persistent faults, over durable sites and read sites. Every call must settle, every resolved call must be right, and after healing the database must reopen with the whole committed log. It also sweeps range deletes on a host with small L0 runs and an L0 stop, and a second handle that writes and syncs between the first one's steps, with one-shot faults and with every file write refused as a full origin. `KV_IO_WIDE=1` adds persistent faults to those, and the range deletes on a host with small runs (about 50 s), `KV_IO_SITES=durable|read` runs one kind of site, and `KV_IO_REPORT=1` prints each sweep's size and error names.

`tests/sim/io-error-crash.test.ts` puts a fault and a crash in one run. A workload with one durable site failing goes on, and its crash states must recover as in `crash-enum.test.ts`. A failed IndexedDB commit, a power loss, new writes and a second power loss must leave a log prefix. A crash state recovered with each site of its recovery failing, once or from then on, must reopen to a log prefix once healed. It samples `KV_CRASH_PAIRS` crash states (default 2) per run and per workload, about 10 s; `KV_CRASH_PAIRS=20` takes about 3 minutes.

`tests/reserve.test.ts` runs a host over `tests/sim/byte-budget.ts`, a folder under an origin's byte limit: a write past the limit fails with `QuotaExceededError`, and a remove gives the bytes back at once. It fills a database until a write is refused, then checks that the flush lands, that one handler call frees half the rows and that the reserve file returns. `tests/reserve-step.test.ts` checks every row of the state table in [reserve.md](reserve.md). `tests/wal-full.test.ts` aborts the WAL transaction of fake-indexeddb with `QuotaExceededError` after its requests succeed, as Chromium and Firefox do at the limit. fake-indexeddb reverts only the keys it generated when a transaction aborts, so `tests/setup.ts` also reverts a key generator that an explicit key moved, as IndexedDB does (design.md, assumption 1).

The tanstack-db suite includes a differential test (`packages/tanstack-db/tests/differential.test.ts`). It generates documents, live queries (a `where`, an order, a window and its moves) and writes through `transact`, TanStack mutations and a second docstore handle. Each query runs over an on-demand collection and over an in-memory collection that holds every document, and both must show the same rows in the same order. It runs 40 cases by default (under 1 s). `tests/differential-wide.test.ts` runs the same check over operators, types and orders that generator leaves out, and over loads that read while both handles write, 200 cases each by default (about 4 s). `TSDB_DIFF_RUNS` widens both, `TSDB_DIFF_SEED` replays a failure, and `TSDB_DIFF_REPORT=1` prints how many loads of each shape TanStack sent. `tests/reads.test.ts` counts the documents each load reads.

## Fuzz the decoders

Every decoder of on-disk or IndexedDB bytes is fuzzed against the rules of [the corruption research note](research/corruption-hardening-test-suite.md) ("Decisions", techniques 7, 8 and 10):

- Everywhere: corrupt or truncated bytes never hang, crash, trap in wasm, read out of bounds (in TypeScript, a `RangeError` from a `DataView`), allocate from a length field, or loop. An error is the documented one: `CorruptDatabaseError`, or `CommitError("corrupt wal row ...")` for a WAL row.
- Where a CRC is checked (manifests, and runs in the SharedWorker's compaction decode), changed bytes throw. They never decode, and never become lost data.
- Where none is (a tab's run reads, block scans, WAL rows and `meta`), a wrong answer is allowed. Tabs keep skipping the SST CRC.

| Layer | Command | Runs in | Covers |
| --- | --- | --- | --- |
| Engine on its checked twin | `pnpm test` (`packages/kv/fuzz/engine-checked.test.ts`) | CI (`test` job) | every export of the wasm engine on entry lists, blocks and pattern lists, and merge sessions over valid and corrupt runs, fed in any order, with early pumps and wrong-length feeds: no memory error on the checked twin, the shipped build's transcript, no trap, and no block or memory past 64 MiB (see [Check the engine](#check-the-engine)) |
| TypeScript properties | `pnpm test` (`packages/kv/fuzz/decoders.test.ts`) | CI (`test` job) | `SstReader` (tab reads, with and without the wasm block scan), `decodeSst`, `decodeGeneration`, `decodeOps` |
| Differential | `pnpm test` (`packages/kv/fuzz/differential.test.ts`, `packages/kv/tests/merge-session.test.ts`) | CI (`test` job) | wasm against TypeScript: the reference writer and decoder in `tests/oracle/sst-ref.ts` against the runs wasm encodes, block scan, and the merge session against its oracle (`tests/oracle/merge-ts.ts`) |
| End to end | `pnpm test` (`packages/kv/tests/sim/corruption.test.ts`) | CI (`test` job) | one corrupt file or IndexedDB row, then open, get, scan, write, flush, compact, reopen |
| Jazzer.js | `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> [seconds]` | by hand; the engine targets also in CI (`engine` job, 60 s each) and nightly (30 minutes each) | `sst-read`, `sst-decode`, `manifest`, `wal-row` (the TypeScript decoders); `engine-encode`, `engine-scan`, `engine-merge` (the wasm engine, on its checked twin) |

The checks are shared: `packages/kv/fuzz/targets.ts` for the TypeScript properties, the differential test and Jazzer.js. Mutations are bit flips, truncation, extension, length fields inflated or nudged by a few, varints near 2^32, runs of 0x00 or 0xff, and splices of two valid files. Each case may rewrite the CRC (and the SST version and magic) so the decoder reaches the structure behind it.

Longer runs and replays:

```sh
cd packages/kv
KV_FUZZ_RUNS=50000 KV_FUZZ_REPORT=1 pnpm exec vitest run fuzz/
KV_FUZZ_SEED=<seed> KV_FUZZ_PATH=<path> pnpm exec vitest run fuzz/decoders.test.ts
KV_CORRUPT_REPORT=1 pnpm exec vitest run tests/sim/corruption.test.ts   # prints the table below
KV_ENGINE_CASES=3000 pnpm exec vitest run fuzz/engine-checked.test.ts
```

`pnpm test` runs 1,000 cases per mutation property, 300 per differential property, and a tenth of those for the slower ones. With the end-to-end file they take about 1 s. `KV_FUZZ_RUNS` scales them, and `KV_ENGINE_CASES` the 100 cases of the engine on its checked twin. `KV_FUZZ_REPORT=1` prints how often each target ran.

Jazzer.js is a dev dependency of `@opfs-lsm/kv`, with prebuilt binaries for macOS, Linux and Windows. Before a change to a decoder or the on-disk format, run each target for 10 minutes or more. A pass prints `Done N runs` and leaves no `crash-*` file. Jazzer instruments the decoder targets' JavaScript. The engine targets instrument none: their coverage is the checked twin's own counters, one per function entry, `if` arm and loop head, and they read their input as the choices of a drive case, so mutations reach the merge session behind valid runs.

Corpora: the decoder seeds are files the engine wrote (a database through ingest and compaction on MemoryFs, plus a compaction's output run), and the engine seeds random bytes. A `sst-read` seed is a manifest of one run, then the run, since a tab reads a run with what its manifest entry records. `pnpm --filter @opfs-lsm/kv fuzz:corpus` writes them again after a format change. Only `seed-*` files are tracked. A run adds its new inputs next to them, and git ignores those.

- `packages/kv/fuzz/corpus/<target>/` for Jazzer.js. A finding lands in `packages/kv/fuzz/.build/crash-*`. Replay it with `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> 0 <file>`.

Each bug the fuzzers found is kept as a regression test reduced to one input: `packages/kv/fuzz/findings.test.ts` and the recovery cases in `tests/sim/corruption.test.ts`. None is open, so the fuzzers skip no input. To report a new bug before it is fixed, pin it with `it.fails` and, if a long run must keep going, skip the inputs that reach it in `targets.ts`, with a clause that names it.

### What the engine does with a corrupt file

| File | Checked by | Corrupt bytes |
| --- | --- | --- |
| Run, any level | Tabs: none. Compaction: CRC. | A tab reads each block where the manifest says it is. A read fails with `CorruptDatabaseError` when the structure of its block breaks or the file is not the size the manifest records, and answers wrong when only data bytes changed. A tab reads the footer only to load the bloom filter: a footer that does not parse, that names more than 32 bloom hashes, or more blocks than its index can hold, fails before it sets a loop or an allocation, and the tab reads the run without a filter. No input traps in wasm, and after a wasm trap the context replaces the instance. Compaction refuses the run with `CorruptDatabaseError` and stops compacting that level until the run is gone. |
| Recorded manifest | Head: CRC, everywhere. A run's block index: its own CRC, in a tab's first read of the run. | With a damaged head, `openDb`, and the SharedWorker's next flush, compaction or sweep, throw `CorruptDatabaseError` and change nothing (design.md, "Corruption is not a power loss"). A manifest written on purpose with a valid CRC and a bad length throws `CorruptDatabaseError` too. With a damaged block index, `openDb` succeeds and a read of that run throws `CorruptDatabaseError`. The host copies an index into the next manifest without reading it. An empty file is a power loss: recovery records the newest intact manifest. |
| Manifest past the recorded one | CRC, recovery | Ignored. |
| A run of the recorded generation, missing | recovery | `openDb` and the host throw `CorruptDatabaseError`, and no file or WAL record is deleted. When an intact manifest holds every ingested seq (a compaction's old or new manifest), it is recorded instead and nothing is lost. |
| WAL row above `ingestedThrough` | none | A row cut short, a row that is not an `ArrayBuffer`, or a row missing between two others fails `openDb` with `CommitError` (`corrupt wal row`, `wal gap`). With the first row past `ingestedThrough` missing, `openDb` succeeds and reads neither the rows after it nor later appends. A row changed into other valid ops reads as those ops. |
| WAL `meta` | none | A value that is not a number reads as 0. With `head` 0 a tab misses the WAL tail. With `generation` naming no manifest, recovery records the intact one and loses nothing. |

Over the SharedWorker port, a host error keeps its class: the port carries the `OpfsLsmError` code, and the tab rethrows `CorruptDatabaseError`, `CommitError` and the others (`errorOfCode`). A `QuotaExceededError` from a host write arrives as `StorageFullError`. Any other error arrives as a plain `Error` with the host's message.

## Check the engine

The wasm engine is AssemblyScript over raw linear memory. A wrong `load`, `store` or `memory.copy` inside the heap does not trap, and compaction would store the bytes it wrote under a valid CRC. These checks catch that class of bug in tests and fuzzing, without a byte of change to the shipped `engine.wasm`.

The checked twin is the same source compiled with an asc transform (`pnpm --filter @opfs-lsm/kv build:wasm-checked`, into `packages/kv/checked/.build/`, not committed; the suites build it when the source changed). Outside the allocator, every load, store, copy and fill first calls a JavaScript hook that keeps one state byte per byte of memory: unallocated, static, uninitialized, initialized, freed, or redzone. Each block gets a 16-byte redzone, and a freed block waits in a 256-block quarantine before the allocator may reuse it. An access to a byte in the wrong state throws `SanitizerError` at the access: an out-of-bounds read or write, a use after free, a double or invalid free, or a read of a byte nothing wrote. At the host boundary the bytes JS writes count as written, a result JS reads must be written in full, and a call made with no merge session open must leave as many blocks live as it found (`merge_close` as many as `merge_open` found). The twin also records the largest block asked for, so a block sized by a corrupt length field shows even when it is refused. It does not see an overflow that stays inside one block, and it does not check the allocator's own accesses. Static memory, from address 0 to the heap, counts as written and writable, so a write through a null pointer or into the CRC tables goes unreported. The old bytes of a reused buffer count as written too. The differential tests against the TypeScript oracles catch what such a write does to the output.

| Check | Command | Runs in | Covers |
| --- | --- | --- | --- |
| The kv suite on the twin | `KV_ENGINE=checked pnpm --filter @opfs-lsm/kv test` | CI (`engine` job) | every kv test with the twin behind the engine bridge. A memory error fails the test it happens in, even when the code under test caught it. Memory figures differ on the twin: they come from the gate. |
| Allocator model | `pnpm test` (`packages/kv/tests/alloc-model.test.ts`) | CI (`test` job), nightly with 1,000 seeds | random allocs, reallocs and frees on the allocator alone: aligned blocks that never overlap, bytes kept across a realloc and while live, and a heap walk that finds blocks tiling the heap with no two free blocks side by side |
| Gate | `pnpm --filter @opfs-lsm/kv engine:gate [--base <rev>]` | CI (`engine` job) | the committed `engine.wasm` against the one at the merge-base with origin/main, below |
| Mutant canary | `pnpm --filter @opfs-lsm/kv mutant-canary [name…]` | nightly | plants each bug of a committed list in a copy of the source and runs the kv suite on its twin: every bug must fail it through the check that owns it (a shadow report, or the allocator model for an allocator bug), and the clean source must pass |

The gate prints a line per axis and fails on any line but speed:

- Output: the same status and bytes on 300 encode, 300 scan and 100 merge drive cases.
- Memory: no page more on three `probe:wasm-memory` workloads (a flush, a merge, a merge with flushes).
- Work: at most 2% more instrumented loads, stores, copies, fills and edges on an encode, a scan and a merge workload, counted on the twins of both builds. The count is the same on every run, so it judges a few percent that shared runners cannot. It is skipped when the base has no AssemblyScript source.
- Speed: the same workloads timed interleaved on both shipped builds. Printed, never judged. Published speed comes from `bench/`.
- Size: no byte more, and the shipped module imports nothing.

A change on purpose takes a trailer on one of the branch's commits: `Engine-Output: changed` lets the output differ, which then rests on the differential tests against the TypeScript oracles, and `Engine-Regression: <memory|work|size> <workload>, <reason>` lets one line regress. The size line's workload is `engine.wasm`.

## Run the static checks

```sh
pnpm static
```

Exit 0. It runs `oxlint`, `lint:engine`, `check:docs`, then `fallow dead-code`. Each fails on a new finding. oxlint and fallow cannot parse the AssemblyScript engine, so `lint:engine` runs asc with `--pedantic` over it and fails on any diagnostic and on any function or method asc never compiled, which is dead code. `@inline` declarations escape the second check.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs eight jobs on pull requests and on pushes to `main`:

- `bench`: `pnpm bench:smoke --check`, which applies the bundle-size budgets of `pnpm bench:size --check`, checks that every access pattern in `bench/core/patterns.ts` has exactly one owner, and then runs the smoke, from one build
- `two-tab`: `pnpm --filter @opfs-lsm/kv two-tab`
- `kill-chrome`: `pnpm --filter @opfs-lsm/kv kill-chrome --seed 1 --iterations 6`, the probes and each kill kind once (about a minute), then `pnpm --filter @opfs-lsm/kv power-loss-chrome`
- `test`: `pnpm test`, stopped after 30 minutes, since an engine that corrupts its heap tends to hang
- `engine`: `KV_ENGINE=checked pnpm --filter @opfs-lsm/kv test`, then `engine:gate` on a pull request, then each engine Jazzer.js target for 60 s from its committed seeds. A finding is uploaded as `engine-findings`.
- `static`: `pnpm lint`, `pnpm lint:engine`, `pnpm check:docs` and `pnpm deadcode` (the steps of `pnpm static`)
- `wasm-fresh`: `pnpm --filter @opfs-lsm/kv build:wasm`, then fails when `packages/kv/wasm/engine.wasm` differs from the committed binary
- `formal`: `pnpm --filter @opfs-lsm/kv formal:kv`

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs every night and on demand (`workflow_dispatch`, with `minutes` and `seed` inputs):

- `kill-chrome`: 30 minutes of the kill loop with `--keep-going` and a random seed. The evidence of a failure is uploaded as `kill-chrome-evidence`.
- `seed-sweep`: random seeds and more runs for the seeded suites, one job each: `KV_MODEL_RUNS=2000` on `model.test.ts` and on `multi-handle.test.ts`, `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` on `crash-enum.test.ts`, `KV_FOLLOW_DEPTH=4` on `tab-follow.test.ts` (no seed: every sequence one command longer), `KV_FUZZ_RUNS=50000` on `fuzz/`, `KV_ENGINE_CASES=3000` on `fuzz/engine-checked.test.ts`, and `KV_ALLOC_SEEDS=1000` on `tests/alloc-model.test.ts`. With no `KV_MODEL_SEED` or `KV_FUZZ_SEED`, each run draws a seed and prints it on a failure, with the path where fast-check gives one. `alloc-model.test.ts` starts its `KV_ALLOC_SEEDS` seeds at a random one and names each one that fails. Replay it with `KV_ALLOC_FIRST=<seed> KV_ALLOC_SEEDS=1`. Replay it with the commands in [Run the unit tests](#run-the-unit-tests) and [Fuzz the decoders](#fuzz-the-decoders).
- `engine-fuzz`: each engine Jazzer.js target for 30 minutes. The corpus a target grows is cached between nights. A finding is uploaded as `engine-fuzz-<target>`.
- `mutant-canary`: `pnpm --filter @opfs-lsm/kv mutant-canary`.

The pull request workflow leaves out the decoder Jazzer.js targets, `two-tab-nobc`, `two-tab-local`, and the full `pnpm bench` families. `bench:smoke` runs every workload on every contender at size `tiny`, which checks correctness and harness health, not speed.

## Refresh a skill

Run `maintain-verification-skill` when a browser-visible path changed and `verify-opfs-lsm/features/` was left behind: a new harness flag, a renamed proof string, a removed page, or a drive whose recipe no longer matches the page. That skill edits only the verify-opfs-lsm directory.

Run `maintain-formal-verification-skill` when code named in the verify-kv coverage record changed after the Sync commit and nobody re-ran `formal:kv` and moved that commit. That skill updates the models and the Sync commit. It leaves product code alone.

While you are changing product code and using verify-kv, follow that skill's "Intentional product change" steps instead: update `packages/kv/formal/`, run `formal:kv`, then set the Sync commit.

`create-verification-skill` and `create-formal-verification-skill` generate a new skill. Both verifiers already exist. Use the maintain skills to refresh them.

## Gaps

These exist on main and have no feature file and no formal check. Leave them out of the feature map until a maintain pass adds a recipe.

- A refused WAL append in a real browser. Chrome's `Storage.overrideQuotaForOrigin` refuses OPFS writes and lets IndexedDB commits through, so `drive quota` proves the reserve on a refused flush only. The retry of a refused append (`make-room`, the new connection) runs in `tests/wal-full.test.ts`, over a fake-indexeddb transaction that aborts the way Chromium and Firefox were measured to.
- The reserve in Firefox and Safari. No drive runs there.
- A SharedWorker that never answers (its script did not load, or the browser killed it) stops writes at `memtableBytes`: a write at the limit waits for a flush that never ends, against design.md "Backpressure". `tests/dead-host-backpressure.test.ts` pins it with `it.fails` until the wait gets a deadline.
