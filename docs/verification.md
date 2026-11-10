# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/collections`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of a page reading its acked writes across ingest, its own records over the runs, view pins, SST merge, and the per-tab ingest queues under crashes.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| A log append or ack (`log/`), the SharedWorker's ingest round (`ingestQueues`), or the page's install | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility` and `formal:ingest-plan`), then `pnpm --filter @opfs-lsm/kv log-queue` |
| `planIngest`, `planReclaim`, `checkCover`, `RECLAIM_LAG`, the log segment format, hand-over and preds, manifest numbering, or the open path | `formal:ingest-plan`, then `tests/sim/crash-enum.test.ts` and `queue-crash-enum.test.ts` with a long sweep (below), then `kill-chrome --minutes 10` |
| Generation loading in `db.ts` or the reclaim lock (`holdingFiles`, `unlessHeld`) | the churn tests in `tests/sim/crash-enum.test.ts`, and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts` |
| A page's own records over the runs (`OwnQueue`), or point get versus SST, including tombstones (`pointGet`) | `formal:own-over-runs`. Add `bench kv/` when the OPFS read after ingest changed. |
| `view()` or the own-record pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, `foldEntries`, `mergeSsts`) | `formal:compact-preserve`, plus `kv-bench` for a real post-ingest get |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| `BrowserFs` (`createWritable`, removes, file locks), the SharedWorker port, or any Web Lock | `kill-chrome --minutes 10` (see [Kill real Chrome](#kill-real-chrome)) |
| `packages/automerge/src/index.ts`, or a kv change claimed to speed up Automerge | `drive automerge-bench`. For a performance claim, rerun with `BENCH_RUNS=5` and compare medians and ranges. |
| `packages/yjs/src/index.ts`, or a kv change claimed to speed up Yjs | `drive yjs-bench`. For a performance claim, rerun with `DOCS=5000 RUNS=5` (a 50k set) and compare medians and ranges. |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. |
| A `Host` on the page (`openHarnessDb` with `fs` and `host`) | `drive two-tab-local`. |
| Collections `put`, `get`, or `where` | `drive collections-bench`. See [Failures already on main](#failures-already-on-main). |
| A decoder or the on-disk format: SST (`sst.ts`, `sst-reader.ts`, `lz4.ts`, `sst.rs`), manifest (`generation.ts`), or log segments and records (`log/segment.ts`, `log/record.ts`) | `pnpm test` and `cargo test -p engine-core`, then each cargo fuzz and Jazzer.js target for 10 minutes (see [Fuzz the decoders](#fuzz-the-decoders)) |
| Any TypeScript behavior | `pnpm test` |
| Any TypeScript or JavaScript source, including a removed export | `pnpm static` (oxlint, then `fallow dead-code`) |

`pendingBytes` and the example load/open benches have no check. See [Gaps](#gaps).

## Run the Chrome proofs

From the repo root, in this order:

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive <feature>
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

`<feature>` is one of `two-tab`, `two-tab-nobc`, `two-tab-local`, `kv-bench`, `collections-bench`, `automerge-bench`, `yjs-bench`. Drive each feature that the table above names. Run `doctor` again after a drive that fails, then `cleanup`, before the next drive.

`launch` installs dependencies when `node_modules` is missing, builds `@opfs-lsm/kv` and `@opfs-lsm/collections`, and runs `doctor`. A checkout with no `dist` fails the first `doctor` (`kv dist: MISSING`). `launch` is the repair.

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH` when set, otherwise `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, otherwise `google-chrome` on `PATH`), `packages/kv/wasm/engine.wasm`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/collections/dist/index.js`, and `node_modules`.

The helper runs:

| Feature | Command |
| --- | --- |
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `kv-bench` | `BENCH_N=50 pnpm bench:browser` |
| `collections-bench` | `BENCH_N=50 pnpm bench:collections` |
| `automerge-bench` | `BENCH_RUNS=1 BENCH_LOADS=2 BENCH_WORKLOADS=trace:100,data/moby-dick.automerge pnpm --filter @opfs-lsm/example-automerge bench:big-doc` |
| `yjs-bench` | `DOCS=100 RUNS=1 pnpm --filter @opfs-lsm/example-yjs bench:load` |

A passing drive prints `drive: ok evidence=...` and exits 0. `exit_code.txt` is `0`. Stdout contains the proof strings:

| Feature | Proof strings |
| --- | --- |
| `two-tab` | `tabs=2`, `mode=SharedWorker`, `two-tab ok` |
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-tab ok`, and `bc_opened=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local Host`, `two-tab ok` |
| `kv-bench` | `mode=SharedWorker + BrowserFs (OPFS)`, `kv solitary put`, `kv one batch`, `kv point get (warm)`, `kv ingest → OPFS`, `kv point get (post-ingest)`. Stdout has no `kv FAILED` line. |
| `collections-bench` | `mode=SharedWorker + BrowserFs (OPFS)`, `collections solitary put`, `collections get by id`, `collections where email` |
| `automerge-bench` | An `== <workload>` table per workload with `kv`, `idb` and `mem` columns, each followed by `checks: goodLoads N/N, errors 0` |
| `yjs-bench` | A `load` table with `kv`, `kv-wal`, `kv-sst` and `idb` rows for `cold` and `warm`, and every `checked` equal to `DOCS` |

Evidence stays after cleanup:

```text
.agents/skills/verify-opfs-lsm/artifacts/<feature>/<run-id>/
  meta.txt
  stdout.txt
  stderr.txt
  exit_code.txt
```

`VERIFY_OPFS_ARTIFACTS` overrides the root. `VERIFY_OPFS_RUN_ID` fixes the run folder name.

`cleanup` removes `packages/kv/.bench-chrome-profile` and `packages/collections/.bench-chrome-profile`. It prints `cleanup: removed fixed bench profiles (if any)` and `cleanup: artifacts preserved under ...`, and exits 0. `kv-bench` and `collections-bench` refuse to start while that profile directory exists.

## Kill real Chrome

`packages/kv/scripts/kill-chrome.ts` kills Chrome under load and checks the database after a relaunch. MemoryFs cannot show the platform facts the design leans on. This loop shows them on the Chrome it runs.

```sh
pnpm --filter @opfs-lsm/kv kill-chrome                         # the probes, then 20 iterations, random seed
pnpm --filter @opfs-lsm/kv kill-chrome --minutes 30 --keep-going
pnpm --filter @opfs-lsm/kv kill-chrome --seed <seed> --from <iteration> --iterations 1 --kinds <kind> --no-probes   # replay
pnpm --filter @opfs-lsm/kv kill-chrome --probes-only
pnpm --filter @opfs-lsm/kv kill-chrome --inspect <db> --profile <kept profile> --port <port>   # dump a kept database's files
```

Each iteration opens 2 or 3 tabs on one database, on one Chrome profile. Each tab runs a seeded workload of puts, deletes and batches over 192 keys into its own log, as fast as its acks come (tens of thousands a second), so the SharedWorker ingests and compacts all the time. A tab has one write in flight at a time. It reports each ack (attempt, log and record number) over a CDP binding within 5 ms, in batches: one event per ack backed the harness up until its own calls timed out. The workload is a function of (seed, iteration, tab), so the harness can regenerate every attempt a tab made. At a seeded time the harness does one of these, in turn:

| Kind | What it does |
| --- | --- |
| `page-crash` | `Page.crash` on one tab, mid-append |
| `reload` | `Page.reload` of one tab, which opens the database again at once while its old log is still being handed over, then closes it |
| `close-worker` | `Target.closeTarget` on the SharedWorker |
| `kill-renderer` | `kill -9` of one renderer process (a tab, the SharedWorker, or both) |
| `kill-browser` | `kill -9` of the browser process |
| `browser-crash` | `Browser.crash` |
| `quota` | `Storage.overrideQuotaForOrigin` at or just above the usage, `ingest()` from a tab, the quota restored, `ingest()` again |

After the browser process dies, the harness waits up to 10 s for Chrome's helpers (the storage service among them) to exit on their own before it kills what is left, so it never kills the storage service mid-write by itself.

When Chrome survives the kill, the other tabs finish their write in flight and close. Then every Web Lock whose name starts with `opfs-lsm` must come free within 20 s, and a new tab must open the database and `ingest()` through a SharedWorker. Chrome is then closed and relaunched on the same profile. A fresh tab opens the database, which runs recovery. It runs `checkDatabase` while holding the compaction and ingest locks (in the host's order), so no ingest, compaction or reclaim runs during the check. Then it reads the whole range and `get`s every key. It writes once, `ingest()`s through the new SharedWorker, and checks again.

A pass means all of these hold:

- The database opens, and `checkDatabase` reports no problem, before and after the ingest.
- `range()` and every `get` equal the state `checkDatabase` folds from the files, and no log has records left that are not ingested.
- No ack is lost: every record the harness saw acked is at or below its log's cursor in the recovered manifest.
- The seqs ingested in the iteration (`through` moved) equal the records the cursors moved.
- The state is a fold of the writers' ingested attempts in an order that keeps each tab's order: each key holds the last write to it of one tab, or what it held before the iteration if no tab surely wrote it. A tab's ingested attempts are its acked ones, the records of its last log past its last seen ack, and at most as many more as records landed in logs no ack named (`verifyState` in the script).
- After the restarted SharedWorker ingests, the state is unchanged apart from the new write, `through` moved by one, and the generation went up.

A process kill is not a power loss, so this is the stronger of the two crash levels in the research note: acked writes survive. The database persists across iterations, so later kills hit a database that earlier kills already crashed. It is replaced every 8 iterations (`--rotate`) and after a failure.

Before the loop, four probes check single facts:

| Probe | Pass |
| --- | --- |
| `tab-locks` | A tab holds the reclaim lock (shared), a run lock (shared) and the ingest lock. After `Page.crash`, another tab gets each one at once. |
| `worker-locks` | The SharedWorker takes the ingest and compaction locks (through a DevTools `Runtime.evaluate`). `Target.closeTarget` removes it from `Target.getTargets`. Both locks come free, and a new tab gets a new SharedWorker that ingests, both while the old client tab is still open and after it closed. |
| `writable-tab-crash` | A tab writes 64 KiB to a file and closes the writer, then writes 8 MiB through a second `createWritable` without closing it. After `Page.crash`, the file still holds the first 64 KiB. |
| `writable-browser-kill` | The same, with `kill -9` of the browser and a relaunch. |

On failure the loop prints the seed, the iteration, the kind, the kill time, the reason and a replay command, writes the evidence (plan, failure, notes, harness log, Chrome stderr) to `--artifacts` (default `$TMPDIR/opfs-kill-chrome`), keeps the profile, and exits 1. Real Chrome does not replay a schedule, so a replay runs the same workload, kind and kill time, not the same interleaving. Run it a few times. A summary at the end prints the iterations per kind, the most orphans and swap files seen, and the errors `ingest()` gave under quota.

What the loop showed on Chrome 157 on macOS (CI runs it on Linux):

- A log record whose SyncAccessHandle `write()` returned survives `Page.crash`, `Page.reload`, `kill -9` of a renderer or of the browser, and `Browser.crash`: every ack the harness saw was ingested after the relaunch.
- An OPFS `createWritable` that a tab or the browser abandons leaves the target file as it was, and recovery opens every state these kills leave.
- Web Locks of a crashed tab and of a closed SharedWorker are released at once.
- `Target.closeTarget` closes a SharedWorker. A new tab gets a new one, and it ingests every log.
- `Storage.overrideQuotaForOrigin` makes OPFS writes fail, the tabs' log appends included: a write rejects with `IndeterminateWriteError`. Ingest fails, the database stays clean, and ingest works again once the quota is back.

What it does not show:

- Power loss. A process kill keeps whatever reached the OS, so the loop never sees a write lost after its ack, or files reaching disk out of order. `crash-enum.test.ts` (lost manifests) and `formal:ingest-plan` (dropped manifests, cut tails, damaged frames) model that. The loop cannot.
- Unacked writes. A write the harness never saw acked may be in its log or not. Losing one is allowed, so the loop cannot tell a lost unacked write from one that never landed.
- The order across tabs. The ingest order is the only order, and the harness does not learn it, so the state check is per key.
- Interleavings it does not hit. Kill times are seeded, but scheduling inside Chrome is not.
- Other browsers.

Three behaviours it found:

- After `kill -9` of the browser mid-`createWritable`, the writer's swap file stays in OPFS as `<name>.crswap`, visible to directory listings. Chrome does not remove it after a relaunch. In a level directory, reclaim takes it for an orphan run and removes it. In `m/` the engine skips the name and nothing removes it, so each browser crash during a manifest write leaks one file. `checkDatabase` lists these as `swapFiles`, not as problems. The loop prints `swap files in the database directory` when it sees one, and the summary prints the most it saw.
- While DevTools is attached to the SharedWorker, a tab that opens the database after `Target.closeTarget` gets no working SharedWorker, and its `ingest()` never settles. Detached, a new one starts. The `worker-locks` probe detaches before it closes the worker.
- Under the OPFS quota, `ingest()` rejects in the tab with a plain `Error` whose message is Chrome's `QuotaExceededError` text. The host's `QuotaExceededError` is not an `OpfsLsmError`, so the port carries no code and the class is lost. It is loud, and nothing is corrupt, but no typed error says the storage is full. A tab's own log append under the quota does reject typed, with `IndeterminateWriteError`.

The IndexedDB findings of the earlier design (Chrome deleting an origin's IndexedDB databases after a browser kill) no longer apply: the engine keeps nothing in IndexedDB.

## Run the formal suite

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Exit 0. The log ends with `All 5 formal checks passed`. Each check prints a `PASS` line:

- `PASS NoLostAcks` (the round and install order parsed from `ingestQueues` and `DbImpl.install`, and 2 broken orders each fail)
- `PASS OwnOverRuns` (16 (own, runs) pairs on real pages)
- `PASS ViewPin` (420 action sequences on real pages)
- `PASS CompactPreserve` (`latestSstEntry` newest-first, `foldEntries` oldest-first)
- `PASS` with the state count of `ingest-plan` (the per-tab ingest queues with crashes, on the real `planIngest`, `planReclaim` and `checkCover`). After it, two findings print: why `RECLAIM_LAG` is 2, and the reorder across logs after a dropped manifest.

The same checks have their own scripts: `formal:ingest-visibility`, `formal:own-over-runs`, `formal:view-pin`, `formal:compact-preserve`, `formal:ingest-plan`. `FORMAL_IQ_APPENDS`, `FORMAL_IQ_COMMITS` and `FORMAL_IQ_SEGCAP` widen the ingest-plan bound, and `FORMAL_IQ_FAILED_OPEN=1` adds a successor log that cannot open. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `2cfa2d5c856af8364d37431af6cf45e6e5361015`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

`pendingBytes` and the host's round triggers are outside the model. A pass says nothing about when a round starts.

## Run the unit tests

```sh
pnpm test
```

Exit 0. The root script checks that `README.md` still contains its required phrases, builds the workspace, and runs the `@opfs-lsm/kv` and `@opfs-lsm/collections` unit suites.

The kv suite includes a model-based test (`packages/kv/tests/sim/model.test.ts`): random histories of writes, reads, views, ingests, compactions and reopens on one handle over a `Host`, checked against a log-prefix oracle, with `checkDatabase` (`tests/sim/check-database.ts`) walking the manifests, runs and logs after every run. It runs 100 + 25 histories by default. For a longer sweep, or to replay a failure from the seed, path and `replayPath` it prints:

```sh
cd packages/kv
KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/model.test.ts
KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/model.test.ts
```

`tests/sim/multi-handle.test.ts` does the same over three handles that share one `Host` and one MemoryFs, each writing its own log, with handles opening and closing. Ops of different handles overlap, and an `fc.scheduler` picks the order of BroadcastChannel deliveries (which can also be dropped), file calls and pauses inside views and ranges (`tests/sim/multi.ts`). The host's ingest plans give each record its seq, and `tests/sim/history.ts` checks the recorded history against that ingest order: every acked record is ingested once, in its log's order; every read is an installed manifest prefix with the reading handle's own acked records on top; each handle's prefix never goes back; a handle reads its writes at ack; `sync()` and open are barriers; a view reads one state; and an `update` sees its own handle's earlier writes. Across handles `update` is last writer wins, so the check accepts two updates that read the same value. It does not check that a handle sees another handle's write without `sync()`, because the design does not promise it. It runs 100 + 100 histories by default (a few seconds) and takes the same `KV_MODEL_*` variables; `KV_SIM_TRACE=1` prints every scheduled task and op. A command stalls a handle's run opens, so a slow catch-up can finish after a newer generation was installed. The harness runs each Web Lock callback in the async context of its requester: Node runs a queued one in the context of whoever released the lock, which would credit a commit to the wrong op.

`tests/sim/crash-enum.test.ts` enumerates crash states. A workload runs once with every durable op traced: OPFS file creates, publishes and removes (`tests/sim/fault-fs.ts`, an `AsyncFs` wrapper), and the log segment writes (`traceSegments` in the same file). Each crash state is rebuilt from a prefix of that trace, reopened, recovered by a fresh host, and checked with `checkDatabase` and the oracle. Two crash models:

- Process crash: one cut in the trace. The database must open and hold every acked write, as a prefix of the ack order.
- Lost manifests: the same cut, then the newest one or two manifests lost too, as a power loss can lose the newest publishes. The logs keep what those manifests ingested, so no acked write may be missing. The recovery round re-ingests every log from the kept manifest's cursors with no order between logs, so the check accepts the kept prefix and then each log's records whole, in any order of the logs (the reorder `formal:ingest-plan` prints).

It covers four fixed workloads (ingest, a reopen between writes, compaction with reclaim, a two-step cascade), every cut of each, and 15 random single-handle histories with 40 sampled lost-manifest cuts each by default (about 15 s). `tests/sim/queue-crash-enum.test.ts` enumerates tabs and the SharedWorker dying around ingest and reclaim. Use `KV_CRASH_RUNS` and `KV_CRASH_PAIRS` for a longer sweep, `KV_CRASH_REPORT=1` to print how many states were checked, and the `KV_MODEL_*` variables to replay. A change to the write order or recovery should pass `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` (about 4 minutes).

The same file holds the churn tests: a tab whose run opens are slow while the host flushes and compacts before each one returns, a tab whose every file call is preceded by four flushes and a compaction, for 40 syncs, and a tab that keeps the reclaim lock while the host flushes and compacts. A healthy database must never report `CorruptDatabaseError`, and the host must never wait for the tab (design.md, "Loading a generation under churn").

`tests/sim/io-error.test.ts` fails fault site N for N = 1, 2, … until a run reaches no site N, with one-shot and persistent faults, over the host's file writes and reads. Every call must settle, every resolved call must be right, and after healing the database must reopen with every acked write. A failed log segment write is covered by the log client and queue history tests. `KV_IO_SITES=durable|read` runs one sweep, and `KV_IO_REPORT=1` prints its size and error names.

## Fuzz the decoders

Every decoder of on-disk bytes is fuzzed against the rules of [the corruption research note](research/corruption-hardening-test-suite.md) ("Decisions", techniques 7, 8 and 10):

- Everywhere: corrupt or truncated bytes never hang, crash, panic in wasm, read out of bounds (in TypeScript, a `RangeError` from a `DataView`), allocate from a length field, or loop. An error is the documented one: `CorruptDatabaseError`.
- Where a CRC is checked (manifests, log record frames, and runs in the SharedWorker's compaction decode), changed bytes throw or end the scan. They never decode.
- Where none is (a tab's run reads, LZ4 unpack, block scans), a wrong answer is allowed. Tabs keep skipping the SST CRC.

| Layer | Command | Runs in | Covers |
| --- | --- | --- | --- |
| Rust properties | `cargo test -p engine-core` | CI (`rust` job) | `decode_sst`, `scan_block_contains`, `merge_sst_bytes` on mutated runs, with an allocation counter (`crates/engine-core/tests/corrupt_inputs.rs`) |
| cargo fuzz | `crates/engine-core/fuzz/run.sh <target> [seconds]` | by hand | `decode_sst`, `scan_block_contains`, `compact` (libFuzzer, nightly) |
| TypeScript properties | `pnpm test` (`packages/kv/fuzz/decoders.test.ts`) | CI (`test` job) | `SstReader` (tab reads, wasm and fallback), `decodeSst`, `decodeGeneration`, the log record body codec, `lz4DecompressJs` |
| Differential | `pnpm test` (`packages/kv/fuzz/differential.test.ts`) | CI (`test` job) | wasm against the TypeScript fallbacks: whole-run decode, block scan, LZ4 unpack, merge |
| Writer against its frozen reference | `cargo test -p engine-core` | CI (`rust` job) | `SstWriter` against `crates/engine-core/src/sst/reference.rs`, the encoder it replaced, frozen: the same bytes for random runs in both codecs, tombstones, empty and large values, many blocks, and every run in the fuzz corpus |
| End to end | `pnpm test` (`packages/kv/tests/sim/corruption.test.ts`) | CI (`test` job) | one corrupt run, manifest or log segment, then open, get, scan, write, ingest, compact, reopen |
| Jazzer.js | `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> [seconds]` | by hand | `sst-read`, `sst-decode`, `manifest`, `record`, `lz4` (the TypeScript decoders; cargo fuzz covers the Rust ones) |

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
| A run of the newest manifest, missing | recovery | `openDb` and the host throw `CorruptDatabaseError`, and no file or log segment is deleted. When an intact manifest holds every ingested seq (a compaction's old or new manifest), it is used instead and nothing is lost. |
| Log segment, a record or the header damaged, or the segment cut mid-record | record frame CRC | The SharedWorker ingests the log up to the damage and marks its cursor `damaged`: the records past it are lost with only a console error, and the writing tab, while it is open, still reads them as its own (`wrong` in the corruption report). The database stays healthy. |

Over the SharedWorker port, a host error keeps its class: the port carries the `OpfsLsmError` code, and the tab rethrows `CorruptDatabaseError`, `CommitError` and the others (`errorOfCode`). Any other error arrives as a plain `Error`.

## Run the static checks

```sh
pnpm static
```

Exit 0. It runs `oxlint`, then `fallow dead-code`. Both fail on a new finding.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs seven jobs on pull requests and on pushes to `main`:

- `bench`: `pnpm bench:size --check`, then `pnpm bench:smoke`
- `two-tab`: `pnpm --filter @opfs-lsm/kv two-tab`, then `pnpm --filter @opfs-lsm/kv log-queue`
- `kill-chrome`: `pnpm --filter @opfs-lsm/kv kill-chrome --seed 1 --iterations 7`, the probes and each kill kind once (about a minute)
- `test`: `pnpm test`
- `static`: `pnpm lint` and `pnpm deadcode` (oxlint, then fallow; the same two steps as `pnpm static`)
- `formal`: `pnpm --filter @opfs-lsm/kv formal:kv`
- `rust`: `cargo test -p engine-core`, which includes the corrupt-input properties

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs every night and on demand (`workflow_dispatch`, with `minutes` and `seed` inputs):

- `kill-chrome`: 30 minutes of the kill loop with `--keep-going` and a random seed. The evidence of a failure is uploaded as `kill-chrome-evidence`.
- `seed-sweep`: random seeds and more runs for the seeded suites, one job each: `KV_MODEL_RUNS=2000` on `model.test.ts` and on `multi-handle.test.ts`, `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` on `crash-enum.test.ts`, and `KV_FUZZ_RUNS=50000` on `fuzz/`. With no `KV_MODEL_SEED` or `KV_FUZZ_SEED`, fast-check draws a seed and prints it, with the path, on a failure. Replay it with the commands in [Run the unit tests](#run-the-unit-tests) and [Fuzz the decoders](#fuzz-the-decoders).

The pull request workflow leaves out cargo fuzz, Jazzer.js, `two-tab-nobc`, `two-tab-local`, `kv-bench`, `collections-bench`, `automerge-bench`, `yjs-bench`, `bench:load`, and `bench:open`. `bench:smoke` is the performance smoke. It is separate from `kv-bench`.

## Failures already on main

The feature files still describe the intended proof (exit 0 and the strings above). On `main` this drive misses that bar. A log that matches the text below is the baseline. Treat it as a new regression only when the error text changes, or when the diff is the path that drive exists to prove.

| Drive | Result on main | CI |
| --- | --- | --- |
| `collections-bench` | Exit 1. The page reports `Failed to resolve module specifier '@opfs-lsm/collections/testing'`. `packages/collections/bench/browser.html` has no import-map entry for that specifier. `packages/collections/dist/testing.js` is present after `launch`. | Absent |

`two-tab`, `two-tab-nobc`, `two-tab-local` and `kv-bench` meet the pass bar above. Require them when the matching row in [Pick the check](#pick-the-check) applies.

## Refresh a skill

Run [maintain-verification-skill](../.agents/skills/maintain-verification-skill/SKILL.md) when a browser-visible path changed and `verify-opfs-lsm/features/` was left behind: a new harness flag, a renamed proof string, a removed page, or a drive whose recipe no longer matches the page. That skill edits only the verify-opfs-lsm directory.

Run [maintain-formal-verification-skill](../.agents/skills/maintain-formal-verification-skill/SKILL.md) when code named in the verify-kv coverage record changed after the Sync commit and nobody re-ran `formal:kv` and moved that commit. That skill updates the models and the Sync commit. It leaves product code alone.

While you are changing product code and using verify-kv, follow that skill's "Intentional product change" steps instead: update `packages/kv/formal/`, run `formal:kv`, then set the Sync commit.

`create-verification-skill` and `create-formal-verification-skill` generate a new skill. Both verifiers already exist. Use the maintain skills to refresh them.

## Gaps

These exist on main and have no feature file and no formal check. Leave them out of the feature map until a maintain pass adds a recipe.

- `pendingBytes` (`packages/kv/src/db.ts`) and the host's round triggers (`batchBytes`, `maxLatencyMs` in `packages/kv/src/host/host.ts`).
- `pnpm --filter @opfs-lsm/example-automerge bench:load` (`examples/automerge-todo/scripts/bench-load.ts`) and `pnpm --filter @opfs-lsm/example-automerge bench:open` (`examples/automerge-todo/scripts/bench-open.ts`). Both are headless Chrome benches. They are outside `verify-opfs-lsm/features/`.
