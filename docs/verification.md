# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/docstore`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of WAL visibility, point get, view pins, SST merge, and power-loss recovery.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| WAL append or ack, `ingestChunk`, `listUningested`, `advanceIngested` | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility` and `formal:power-loss`) |
| The write order of ingest, compaction install or reclaim, `reconcile`, `IdBWal.adopt`, manifest numbering, or the open path | `formal:power-loss`, then `tests/sim/crash-enum.test.ts` with a long sweep (below), then `power-loss-chrome` (see [Lose IndexedDB commits in real Chrome](#lose-indexeddb-commits-in-real-chrome)), then `kill-chrome --minutes 10` |
| Generation loading in `db.ts` (`syncOnce`, `write`, `load`) or the reclaim lock (`holdingFiles`, `unlessHeld`) | `formal:power-loss`, the churn tests in `tests/sim/crash-enum.test.ts`, and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts` |
| Point get versus SST, including tombstones (`pointGet`, `readKey`) | `formal:wal-over-sst`. Add `drive bench kv/` when the OPFS read after ingest changed. |
| `view()` or the memtable pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, the merge session in `merge.rs` and its oracle `tests/oracle/merge-ts.ts`, `host/compact.ts`) | `formal:compact-preserve`, `cargo test -p engine-core`, plus `drive bench kv/` for a real post-ingest get |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| `BrowserFs` (`createWritable`, removes, file locks), the SharedWorker port, or any Web Lock | `kill-chrome --minutes 10` (see [Kill real Chrome](#kill-real-chrome)) |
| `packages/automerge/src/index.ts`, or a kv change claimed to speed up Automerge | `drive bench automerge/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/yjs/src/index.ts`, or a kv change claimed to speed up Yjs | `drive bench yjs/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/fate/src/index.ts`, or a kv change claimed to speed up fate's persistence | `pnpm --filter @opfs-lsm/fate test` and `drive bench fate/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. |
| In-page `EngineHost` | `drive two-tab-local`. |
| `maxBytes`, `onPressure`, the pressure offer or its Web Lock | `drive pressure`, and `drive quota` for `maxBytes: "quota"`. |
| `packages/docstore/src`, or a kv change claimed to speed up documents | `drive bench table/`. For a performance claim, run it with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `packages/tanstack-db/src` | `pnpm --filter @opfs-lsm/tanstack-db test`, with `TSDB_DIFF_RUNS=2000` after a change to the planner or the on-demand run. For a performance claim, `drive bench tanstack/` with `--reps 5` before and after, then `node bench/cli.ts compare`. |
| `examples/linearlite` | `pnpm --filter @opfs-lsm/example-linearlite test`, `check` and `build`. For a change to its reads, counts or sync, `node examples/linearlite/bench/client.ts <origin> warm ui first-sync` against a production build (`vite build`, `vite preview`) seeded with 100k issues, and `tabs users offline visible` against a copy of that server database. For a performance claim, 5 interleaved runs before and after (`examples/linearlite/DESIGN.md`, Measured). |
| `examples/linearlite-fate` | `pnpm --filter @opfs-lsm/example-linearlite-fate test`, `check` and `build`. For a change to its requests, commands or server, drive the app in a browser against a seeded database, once with the default storage and once with `?storage=idb` (`examples/linearlite-fate/DESIGN.md`). |
| A decoder or the on-disk format: SST (`sst.ts`, `sst-reader.ts`, `lz4.ts`, `sst.rs`, and the merge session that reads runs, `merge.rs`), manifest (`generation.ts`), WAL rows (`decodeOps`), or `recover.ts` | `pnpm test` and `cargo test -p engine-core`, then each cargo fuzz and Jazzer.js target for 10 minutes (see [Fuzz the decoders](#fuzz-the-decoders)) |
| Any TypeScript behavior | `pnpm test` |
| Any TypeScript or JavaScript source, including a removed export | `pnpm static` (oxlint, then `fallow dead-code`) |

`pendingBytes` has no check. See [Gaps](#gaps).

## Run the Chrome proofs

From the repo root, in this order:

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive <feature>
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

`<feature>` is one of `two-tab`, `two-tab-nobc`, `two-tab-local`, `pressure`, `quota`, `bench <selector…> [--size tiny|small|large] [--reps N] [--contenders a,b]` and `bench-smoke`. A selector is a family (`kv/`, `table/`, `automerge/`, `yjs/`, `fate/`) or one workload such as `kv/fillrandom`. Drive each feature that the table above names. Run `doctor` again after a drive that fails, then `cleanup`, before the next drive.

`launch` installs dependencies when `node_modules` is missing, builds `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/yjs` and `@opfs-lsm/automerge`, and runs `doctor`. A checkout with no `dist` fails the first `doctor` (`kv dist: MISSING`). `launch` is the repair.

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH` when set, otherwise `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, otherwise `google-chrome` on `PATH`), `packages/kv/wasm/engine.wasm`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/docstore/dist/index.js`, and `node_modules`.

The helper runs:

| Feature | Command |
| --- | --- |
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `pressure` | `TWO_TAB_PRESSURE=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `quota` | `TWO_TAB_QUOTA=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `bench <selector…>` | `pnpm bench <selector…>`, with the flags after it |
| `bench-smoke` | `pnpm bench:smoke` |

A passing drive prints `drive: ok evidence=...` and exits 0. `exit_code.txt` is `0`. Stdout contains the proof strings:

| Feature | Proof strings |
| --- | --- |
| `two-tab` | `tabs=2`, `mode=SharedWorker`, `two-tab ok` |
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-tab ok`, and `bc_posts=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local EngineHost`, `two-tab ok` |
| `pressure` | `tabs=2`, `mode=SharedWorker`, `pressure answered by tab`, `both tabs read`, `no handler: one warning in each tab`, `pressure ok` |
| `quota` | `tabs=2`, `mode=SharedWorker`, `handler 1 starts`, `handler calls: `, `quota ok`. Read the timeline: more than one call means a repeated offer. |
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
```

Exit 0 and a last line `power-loss-chrome ok (5 scenarios)`. Each scenario checks that:

- the relaunched Chrome reads the copy (the loss happened);
- the open reads a prefix of the writes, at least the ones the kept flush holds;
- a `put` after the open takes a seq past `ingestedThrough` and every WAL key, and is read back in that tab and after a restart.

The scenarios lose the newest records, every record, or the commit of a second flush, and two of them lose the recovery itself a second time. The key generator of `wal` is in the copied directory, so it goes back with the records. That is the fact fake-indexeddb can only model: an adopt that does not move the key generator fails all five, because the put takes a seq already in use (`the put took seq 8, at or below 20` in the first).

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

Exit 0. The log ends with `All 5 formal checks passed`. Each check prints a `PASS` line:

- `PASS NoLostAcks`
- `PASS WalOverSst` (on real `pointGet`)
- `PASS ViewPin` (copy-on-write memtable pin present)
- `PASS CompactPreserve` (`latestSstEntry` newest-first, both merge sessions give a tie to the newer source and drop a covered winner, outputs claim the base manifest's marks only), after two `broken variant caught` lines
- `PASS PowerPrefix` (every power-loss crash state, two power losses deep, recovers to a log prefix). Before it, eleven `broken variant caught` lines show the model fails each known wrong design. The model holds the key generator of `wal`, so a crash state that loses commits also loses what they did to it.
- `PASS CorruptRefuse` (a run of the recorded manifest removed after every workload: open refuses and nothing writes, unless a manifest that holds every ingested seq stands in)

The same checks have their own scripts: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:power-loss`. `formal:power-loss` runs every workload twice: with reclaim, and with a tab holding the reclaim lock throughout, so the host removes no manifest or run. Its workloads mix appends, ingests, compactions and destroys. `FORMAL_POWER_CMDS` (default 6) and `FORMAL_POWER_CRASHES` (default 2) widen the power-loss bound; the default bound takes about a minute. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `8138007237b19dd658127df296f9e65294e3a309`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

`pendingBytes` is outside the model. A pass says nothing about the ingest trigger.

## Run the unit tests

```sh
pnpm test
```

Exit 0. The root script checks that `README.md` still contains its required phrases and builds the six packages. Then it runs the unit suites of `@opfs-lsm/kv`, `@opfs-lsm/docstore`, `@opfs-lsm/yjs`, `@opfs-lsm/automerge`, `@opfs-lsm/tanstack-db` and `@opfs-lsm/fate` (`test:suites`) while it builds the example apps (`test:examples`). A failure in either fails the command.

The kv suite includes a model-based test (`packages/kv/tests/sim/model.test.ts`): random histories of writes, reads, views, ingests, compactions and reopens on one handle, checked against a log-prefix oracle, with `checkDatabase` (`tests/sim/check-database.ts`) walking the WAL, manifest and runs after every run. It runs 100 + 25 histories by default. For a longer sweep, or to replay a failure from the seed, path and `replayPath` it prints:

```sh
cd packages/kv
KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/model.test.ts
KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/model.test.ts
```

`tests/sim/multi-handle.test.ts` does the same over three handles that share one host, one MemoryFs and one fake-indexeddb, with handles opening and closing. Ops of different handles overlap, and an `fc.scheduler` picks the order of BroadcastChannel deliveries (which can also be dropped), file calls and pauses inside views and ranges (`tests/sim/multi.ts`). No row waits on a timer there: every second session posts each row as it lands, and the others post their first row and keep the rest until they close, so one message carries many rows. The recorded history is checked seq-exactly by `tests/sim/history.ts`: every read is a log prefix, each handle's prefix never goes back, read-your-writes at ack, `sync()` and open are barriers, a view reads one prefix, and an `update` reads exactly the state before its own seq, so concurrent increments lose nothing. It does not check that a handle sees another handle's write without `sync()`, because the design does not promise it. It runs 100 + 100 histories by default (a few seconds) and takes the same `KV_MODEL_*` variables; `KV_SIM_TRACE=1` prints every scheduled task and op. A command stalls a handle's run opens, so a slow catch-up can finish after a newer generation was installed. The harness runs each Web Lock callback in the async context of its requester: Node runs a queued one in the context of whoever released the lock, which would credit a commit to the wrong op.

`tests/sim/crash-enum.test.ts` enumerates crash states. A workload runs once with every durable op traced: OPFS file creates, publishes and removes (`tests/sim/fault-fs.ts`, an `AsyncFs` wrapper), and IndexedDB commits (`tests/sim/fault-wal.ts`, a wrapper on fake-indexeddb's object store, with no product seam). Each crash state is rebuilt from a prefix of that trace, reopened, recovered by a fresh host, and checked with `checkDatabase` and the oracle. Two crash models:

- Process crash: one cut in the global order. The database must open and hold the whole committed log.
- Power loss: each store keeps its own prefix. The database must open and hold some log prefix (design.md, "Recovery"). Every pair is checked, except the ones that keep an OPFS op after a strict IndexedDB commit and lose that commit, which no power loss leaves.

It covers four fixed workloads (ingest, compaction with reclaim, a two-step cascade, two destroys over runs and a WAL tail), every pair of each, and 15 random single-handle histories with 40 sampled pairs each by default (about 15 s). Use `KV_CRASH_RUNS` and `KV_CRASH_PAIRS` for a longer sweep, `KV_CRASH_REPORT=1` to print how many states were checked, and the `KV_MODEL_*` variables to replay. A change to the write order or recovery should pass `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` (about 4 minutes).

The same file holds the churn tests: a tab whose run opens are slow while the host flushes and compacts before each one returns, a tab whose every file call is preceded by four flushes and a compaction, for 40 syncs, and a tab that keeps the reclaim lock while the host flushes and compacts. A healthy database must never report `CorruptDatabaseError`, and the host must never wait for the tab (design.md, "Loading a generation under churn").

`tests/sim/io-error.test.ts` fails fault site N for N = 1, 2, … until a run reaches no site N, with one-shot and persistent faults, over durable sites and read sites. Every call must settle, every resolved call must be right, and after healing the database must reopen with the whole committed log. `KV_IO_SITES=durable|read` runs one sweep, and `KV_IO_REPORT=1` prints its size and error names.

The tanstack-db suite includes a differential test (`packages/tanstack-db/tests/differential.test.ts`). It generates documents, live queries (a `where`, an order, a window and its moves) and writes through `transact`, TanStack mutations and a second docstore handle. Each query runs over an on-demand collection and over an in-memory collection that holds every document, and both must show the same rows in the same order. It runs 40 cases by default (under 1 s). `TSDB_DIFF_RUNS` widens it, `TSDB_DIFF_SEED` replays a failure, and `TSDB_DIFF_REPORT=1` prints how many loads of each shape TanStack sent. `tests/reads.test.ts` counts the documents each load reads.

## Fuzz the decoders

Every decoder of on-disk or IndexedDB bytes is fuzzed against the rules of [the corruption research note](research/corruption-hardening-test-suite.md) ("Decisions", techniques 7, 8 and 10):

- Everywhere: corrupt or truncated bytes never hang, crash, panic in wasm, read out of bounds (in TypeScript, a `RangeError` from a `DataView`), allocate from a length field, or loop. An error is the documented one: `CorruptDatabaseError`, or `CommitError("corrupt wal row ...")` for a WAL row.
- Where a CRC is checked (manifests, and runs in the SharedWorker's compaction decode), changed bytes throw. They never decode, and never become lost data.
- Where none is (a tab's run reads, LZ4 unpack, block scans, WAL rows and `meta`), a wrong answer is allowed. Tabs keep skipping the SST CRC.

| Layer | Command | Runs in | Covers |
| --- | --- | --- | --- |
| Rust properties | `cargo test -p engine-core` | CI (`rust` job) | `decode_sst`, `scan_block_contains`, the session's block decoder and a merge session on mutated runs, with an allocation counter (`crates/engine-core/tests/corrupt_inputs.rs`); the merge session against the merge it replaced, frozen (`crates/engine-core/src/merge/oracle.rs`) |
| cargo fuzz | `crates/engine-core/fuzz/run.sh <target> [seconds]` | by hand | `decode_sst`, `scan_block_contains`, `decode_block`, `merge_session` (libFuzzer, nightly) |
| TypeScript properties | `pnpm test` (`packages/kv/fuzz/decoders.test.ts`) | CI (`test` job) | `SstReader` (tab reads, with the wasm decoders and with the JS ones), `decodeSst`, `decodeGeneration` (version 3), `decodeOps`, `lz4DecompressJs` |
| Differential | `pnpm test` (`packages/kv/fuzz/differential.test.ts`, `packages/kv/tests/merge-session.test.ts`) | CI (`test` job) | wasm against TypeScript: TypeScript decoding the runs wasm encodes, block scan, LZ4 unpack, and the merge session against its oracle (`tests/oracle/merge-ts.ts`) |
| Writer against its frozen reference | `cargo test -p engine-core` | CI (`rust` job) | `SstWriter` against `crates/engine-core/src/sst/reference.rs`, the encoder it replaced, frozen: the same bytes for random runs in both codecs, tombstones, empty and large values, many blocks, and every run in the fuzz corpus |
| End to end | `pnpm test` (`packages/kv/tests/sim/corruption.test.ts`) | CI (`test` job) | one corrupt file or IndexedDB row, then open, get, scan, write, flush, compact, reopen |
| Jazzer.js | `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> [seconds]` | by hand | `sst-read`, `sst-decode`, `manifest`, `wal-row`, `lz4` (the TypeScript decoders; cargo fuzz covers the Rust ones) |

The checks are shared: `packages/kv/fuzz/targets.ts` for the TypeScript properties, the differential test and Jazzer.js, and `crates/engine-core/tests/support/corrupt.rs` for the Rust properties and cargo fuzz. Mutations are bit flips, truncation, extension, length fields inflated or nudged by a few, varints near 2^32, runs of 0x00 or 0xff, and splices of two valid files. Each case may rewrite the CRC (and the SST version and magic) so the decoder reaches the structure behind it.

Longer runs and replays:

```sh
cd packages/kv
KV_FUZZ_RUNS=50000 KV_FUZZ_REPORT=1 pnpm exec vitest run fuzz/
KV_FUZZ_SEED=<seed> KV_FUZZ_PATH=<path> pnpm exec vitest run fuzz/decoders.test.ts
KV_CORRUPT_REPORT=1 pnpm exec vitest run tests/sim/corruption.test.ts   # prints the table below
ENGINE_PROP_CASES=100000 cargo test --release -p engine-core --test corrupt_inputs
```

`pnpm test` runs 1,000 cases per mutation property, 300 per differential property, and a tenth of those for the slower ones. With the end-to-end file they take about 1 s. `KV_FUZZ_RUNS` and `ENGINE_PROP_CASES` scale them. `KV_FUZZ_REPORT=1` prints how often each target ran.

cargo fuzz needs `rustup toolchain install nightly` and `cargo install cargo-fuzz`. Jazzer.js is a dev dependency of `@opfs-lsm/kv`, with prebuilt binaries for macOS, Linux and Windows. Before a change to a decoder or the on-disk format, run each target for 10 minutes or more. A pass prints `Done N runs` and leaves no `crash-*` file.

Corpora: the seeds are files the engine wrote (a database through ingest and compaction on MemoryFs, plus wasm LZ4 runs). `pnpm --filter @opfs-lsm/kv fuzz:corpus` writes them again after a format change. Only `seed-*` files are tracked. A run adds its new inputs next to them, and git ignores those.

- `packages/kv/fuzz/corpus/<target>/` for Jazzer.js. A finding lands in `packages/kv/fuzz/.build/crash-*`. Replay it with `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> 0 <file>`.
- `crates/engine-core/fuzz/corpus/<target>/` for cargo fuzz. A finding lands in `crates/engine-core/fuzz/artifacts/<target>/`. Replay it with `cargo +nightly fuzz run <target> <file>`.

Each bug the fuzzers found is kept as a regression test reduced to one input: `packages/kv/fuzz/findings.test.ts`, the recovery cases in `tests/sim/corruption.test.ts`, and the KB tests in `corrupt_inputs.rs`. None is open, so the fuzzers skip no input. To report a new bug before it is fixed, pin it with `it.fails` (or `#[ignore]`) and, if a long run must keep going, skip the inputs that reach it in `targets.ts` or `corrupt.rs`, with a clause that names it.

### What the engine does with a corrupt file

| File | Checked by | Corrupt bytes |
| --- | --- | --- |
| L0 or L1 run (raw) | Tabs: none. Compaction: CRC. | A tab read fails with `CorruptDatabaseError` when the structure breaks, or answers wrong when only data bytes changed. A footer that names more than 32 bloom hashes, or more blocks than its index can hold, fails before it sets a loop or an allocation. Compaction refuses the run with `CorruptDatabaseError` and stops compacting that level until the run is gone. |
| L2+ run (LZ4) | Tabs: none. Compaction: CRC. | A changed compressed byte fails the read with `CorruptDatabaseError`. A block size past 255 times the compressed bytes fails before it is allocated. No input panics in wasm; after any wasm trap the context drops wasm and reads with the TypeScript codec. |
| Recorded manifest | CRC, everywhere | `openDb`, and the SharedWorker's next flush, compaction or sweep, throw `CorruptDatabaseError` and change nothing (design.md, "Corruption is not a power loss"). A manifest written on purpose with a valid CRC and a bad length throws `CorruptDatabaseError` too. An empty file is a power loss: recovery records the newest intact manifest. |
| Manifest past the recorded one | CRC, recovery | Ignored. |
| A run of the recorded generation, missing | recovery | `openDb` and the host throw `CorruptDatabaseError`, and no file or WAL record is deleted. When an intact manifest holds every ingested seq (a compaction's old or new manifest), it is recorded instead and nothing is lost. |
| WAL row above `ingestedThrough` | none | A row cut short, a row that is not an `ArrayBuffer`, or a missing row fails `openDb` with `CommitError` (`corrupt wal row`, `wal gap`). A row changed into other valid ops reads as those ops. |
| WAL `meta` | none | A value that is not a number reads as 0. With `head` 0 a tab misses the WAL tail. With `generation` naming no manifest, recovery records the intact one and loses nothing. |

Over the SharedWorker port, a host error keeps its class: the port carries the `OpfsLsmError` code, and the tab rethrows `CorruptDatabaseError`, `CommitError` and the others (`errorOfCode`). A `QuotaExceededError` from a host write arrives as `StorageFullError`. Any other error arrives as a plain `Error` with the host's message.

## Run the static checks

```sh
pnpm static
```

Exit 0. It runs `oxlint`, then `fallow dead-code`. Both fail on a new finding.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs seven jobs on pull requests and on pushes to `main`:

- `bench`: `pnpm bench:smoke --check`, which applies the bundle-size budgets of `pnpm bench:size --check` and then runs the smoke, from one build
- `two-tab`: `pnpm --filter @opfs-lsm/kv two-tab`
- `kill-chrome`: `pnpm --filter @opfs-lsm/kv kill-chrome --seed 1 --iterations 6`, the probes and each kill kind once (about a minute), then `pnpm --filter @opfs-lsm/kv power-loss-chrome`
- `test`: `pnpm test`
- `static`: `pnpm lint` and `pnpm deadcode` (oxlint, then fallow; the same two steps as `pnpm static`)
- `formal`: `pnpm --filter @opfs-lsm/kv formal:kv`
- `rust`: `cargo test -p engine-core`, which includes the corrupt-input properties

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs every night and on demand (`workflow_dispatch`, with `minutes` and `seed` inputs):

- `kill-chrome`: 30 minutes of the kill loop with `--keep-going` and a random seed. The evidence of a failure is uploaded as `kill-chrome-evidence`.
- `seed-sweep`: random seeds and more runs for the seeded suites, one job each: `KV_MODEL_RUNS=2000` on `model.test.ts` and on `multi-handle.test.ts`, `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` on `crash-enum.test.ts`, and `KV_FUZZ_RUNS=50000` on `fuzz/`. With no `KV_MODEL_SEED` or `KV_FUZZ_SEED`, fast-check draws a seed and prints it, with the path, on a failure. Replay it with the commands in [Run the unit tests](#run-the-unit-tests) and [Fuzz the decoders](#fuzz-the-decoders).

The pull request workflow leaves out cargo fuzz, Jazzer.js, `two-tab-nobc`, `two-tab-local`, and the full `pnpm bench` families. `bench:smoke` runs every workload on every contender at size `tiny`, which checks correctness and harness health, not speed.

## Refresh a skill

Run `maintain-verification-skill` when a browser-visible path changed and `verify-opfs-lsm/features/` was left behind: a new harness flag, a renamed proof string, a removed page, or a drive whose recipe no longer matches the page. That skill edits only the verify-opfs-lsm directory.

Run `maintain-formal-verification-skill` when code named in the verify-kv coverage record changed after the Sync commit and nobody re-ran `formal:kv` and moved that commit. That skill updates the models and the Sync commit. It leaves product code alone.

While you are changing product code and using verify-kv, follow that skill's "Intentional product change" steps instead: update `packages/kv/formal/`, run `formal:kv`, then set the Sync commit.

`create-verification-skill` and `create-formal-verification-skill` generate a new skill. Both verifiers already exist. Use the maintain skills to refresh them.

## Gaps

These exist on main and have no feature file and no formal check. Leave them out of the feature map until a maintain pass adds a recipe.

- `pendingBytes`, the ingest trigger in `packages/kv/src/host/engine-host.ts` and the WAL meta key of the same name in `packages/kv/src/idb/wal.ts`.
