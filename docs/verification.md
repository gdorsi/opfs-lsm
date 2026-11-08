# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/collections`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of WAL visibility, point get, view pins, SST merge, and power-loss recovery.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives and benches those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| WAL append or ack, `ingestAll`, `listUningested`, `advanceIngested` | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility` and `formal:power-loss`) |
| The write order of ingest, compaction install or reclaim, `reconcile`, `IdBWal.adopt`, manifest numbering, or the open path | `formal:power-loss`, then `tests/sim/crash-enum.test.ts` with a long sweep (below) |
| Generation loading in `db.ts` (`syncOnce`, `write`, `load`) or the reclaim lock (`holdingFiles`, `unlessHeld`) | `formal:power-loss`, the churn tests in `tests/sim/crash-enum.test.ts`, and `KV_MODEL_RUNS=2000` on `multi-handle.test.ts` |
| Point get versus SST, including tombstones (`pointGet`, `readKey`) | `formal:wal-over-sst`. Add `pnpm bench kv/` when the OPFS read after ingest changed. |
| `view()` or the memtable pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, `foldEntries`, `mergeSsts`) | `formal:compact-preserve`, plus `pnpm bench kv/` for real reads after flush and compaction |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| `examples/automerge-todo/src/storage.ts`, or a kv change claimed to speed up Automerge | `pnpm bench automerge/` |
| `examples/yjs/src/kv-persistence.ts`, or a kv change claimed to speed up Yjs | `pnpm bench yjs/` |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. |
| In-page `EngineHost` | `drive two-tab-local`. |
| Collections `put`, `get`, or `where` | `pnpm bench table/` |
| Any claim that a change makes something faster or slower | The matching `pnpm bench <family>/` with `--reps 5` or more, before and after. See [Run the benchmarks](#run-the-benchmarks). |
| A change to bundle size, or to what `openDb` loads | `pnpm bench:size --check` |
| A decoder or the on-disk format: SST (`sst.ts`, `sst-reader.ts`, `lz4.ts`, `sst.rs`), manifest (`generation.ts`), WAL rows (`decodeOps`), or `recover.ts` | `pnpm test` and `cargo test -p engine-core`, then each cargo fuzz and Jazzer.js target for 10 minutes (see [Fuzz the decoders](#fuzz-the-decoders)) |
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

`<feature>` is one of `two-tab`, `two-tab-nobc`, `two-tab-local`, `bench <selector…>`, and `bench-smoke`. `drive bench kv/` runs `pnpm bench kv/` and keeps the evidence. Drive each feature that the table above names. Run `doctor` again after a drive that fails, then `cleanup`, before the next drive.

`launch` installs dependencies when `node_modules` is missing, builds `@opfs-lsm/kv` and `@opfs-lsm/collections`, and runs `doctor`. A checkout with no `dist` fails the first `doctor` (`kv dist: MISSING`). `launch` is the repair.

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH` when set, otherwise `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, otherwise `google-chrome` on `PATH`), `packages/kv/wasm/engine_wasm_bg.wasm`, `packages/kv/wasm/engine_wasm.js`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/collections/dist/index.js`, and `node_modules`.

The helper runs:

| Feature | Command |
| --- | --- |
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `bench <args…>` | `pnpm bench <args…>` |
| `bench-smoke` | `pnpm bench:smoke` |

A passing drive prints `drive: ok evidence=...` and exits 0. `exit_code.txt` is `0`. Stdout contains the proof strings:

| Feature | Proof strings |
| --- | --- |
| `two-tab` | `tabs=2`, `mode=SharedWorker`, `two-tab ok` |
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-tab ok`, and `bc_posts=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local EngineHost`, `two-tab ok` |
| `bench`, `bench-smoke` | A `## <family>/<workload>: <title>` section per workload with a row per contender. Stdout has no `## Failed runs` section. |

Evidence stays after cleanup:

```text
.agents/skills/verify-opfs-lsm/artifacts/<feature>/<run-id>/
  meta.txt
  stdout.txt
  stderr.txt
  exit_code.txt
```

`VERIFY_OPFS_ARTIFACTS` overrides the root. `VERIFY_OPFS_RUN_ID` fixes the run folder name.

Every harness uses a fresh temp Chrome profile, so `cleanup` has nothing to remove. It prints `cleanup: artifacts preserved under ...` and exits 0.

## Run the benchmarks

The suite in `bench/` runs each workload in headless Chrome against every contender of its family. Every read is checked against a model, so a wrong value fails the run.

| Family | Contenders |
| --- | --- |
| `kv/` | `kv/kv` (`@opfs-lsm/kv`) and `kv/idb` (raw IndexedDB) |
| `table/` | `table/collections` and `table/dexie` |
| `automerge/` | `automerge/kv` (the kv storage adapter) and `automerge/idb` (`IndexedDBStorageAdapter`) |
| `yjs/` | `yjs/kv` (`KvPersistence`) and `yjs/y-indexeddb` |

```sh
pnpm bench kv/                                   # one family, size small, 5 reps
pnpm bench kv/fillrandom --size tiny --reps 1    # one workload, fast
pnpm bench table/ --contenders collections       # one contender
pnpm bench:smoke                                 # everything at size tiny, 1 rep
pnpm bench:size --check                          # bundle sizes against each row's budget
```

`pnpm bench` exits 0 when every run passed. It writes `bench/results/<stamp>-<host>.jsonl` and a `.md` report beside it. Both are gitignored. The report has a section per workload. A failed run is listed under `## Failed runs`, and the command exits 1.

`bench:smoke` checks correctness and harness health. Its timings are not evidence of speed.

To back a performance claim, run the family with `--reps 5` or more on the base commit and on the change, then compare the two files:

```sh
node bench/cli.ts compare before.jsonl after.jsonl
```

The verdict is `B faster` or `B slower` only when the min–max ranges of per-run ops/s do not overlap. `≈ no measurable difference` means they overlap. `node bench/cli.ts report <file.jsonl>` reprints one result file.

`bench:size` builds the bench with Vite and prints raw, gzip, and brotli bytes for each import, at import and after open (SharedWorker and wasm included). `--check` exits 1 when a row is over its budget in `bench/size/rows.ts`.

## Run the formal suite

```sh
pnpm --filter @opfs-lsm/kv formal:kv
```

Exit 0. The log ends with `All 5 formal checks passed`. Each check prints a `PASS` line:

- `PASS NoLostAcks`
- `PASS WalOverSst` (on real `pointGet`)
- `PASS ViewPin` (copy-on-write memtable pin present)
- `PASS CompactPreserve` (`latestSstEntry` newest-first, `foldEntries` oldest-first)
- `PASS PowerPrefix` (every power-loss crash state, two power losses deep, recovers to a log prefix). Before it, five `broken variant caught` lines show the model fails each known wrong design.

The same checks have their own scripts: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:power-loss`. `formal:power-loss` runs every workload twice: with reclaim, and with a tab holding the reclaim lock throughout, so the host removes no manifest or run. `FORMAL_POWER_CMDS` (default 6) and `FORMAL_POWER_CRASHES` (default 2) widen the power-loss bound; 7 commands or 3 crashes take about 11 s. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `0e34b2e00478119e96eec08b4ee93434308f8800`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

`pendingBytes` is outside the model. A pass says nothing about the ingest trigger.

## Run the unit tests

```sh
pnpm test
```

Exit 0. The root script checks that `README.md` still contains its required phrases, builds the workspace, and runs the `@opfs-lsm/kv` and `@opfs-lsm/collections` unit suites.

The kv suite includes a model-based test (`packages/kv/tests/sim/model.test.ts`): random histories of writes, reads, views, ingests, compactions and reopens on one handle, checked against a log-prefix oracle, with `checkDatabase` (`tests/sim/check-database.ts`) walking the WAL, manifest and runs after every run. It runs 100 + 25 histories by default. For a longer sweep, or to replay a failure from the seed, path and `replayPath` it prints:

```sh
cd packages/kv
KV_MODEL_RUNS=2000 pnpm exec vitest run tests/sim/model.test.ts
KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/model.test.ts
```

`tests/sim/multi-handle.test.ts` does the same over three handles that share one host, one MemoryFs and one fake-indexeddb, with handles opening and closing. Ops of different handles overlap, and an `fc.scheduler` picks the order of BroadcastChannel deliveries (which can also be dropped), file calls and pauses inside views and ranges (`tests/sim/multi.ts`). The recorded history is checked seq-exactly by `tests/sim/history.ts`: every read is a log prefix, each handle's prefix never goes back, read-your-writes at ack, `sync()` and open are barriers, a view reads one prefix, and an `update` reads exactly the state before its own seq, so concurrent increments lose nothing. It does not check that a handle sees another handle's write without `sync()`, because the design does not promise it. It runs 100 + 100 histories by default (a few seconds) and takes the same `KV_MODEL_*` variables; `KV_SIM_TRACE=1` prints every scheduled task and op. A command stalls a handle's run opens, so a slow catch-up can finish after a newer generation was installed. The harness runs each Web Lock callback in the async context of its requester: Node runs a queued one in the context of whoever released the lock, which would credit a commit to the wrong op.

`tests/sim/crash-enum.test.ts` enumerates crash states. A workload runs once with every durable op traced: OPFS file creates, publishes and removes (`tests/sim/fault-fs.ts`, an `AsyncFs` wrapper), and IndexedDB commits (`tests/sim/fault-wal.ts`, a wrapper on fake-indexeddb's object store, with no product seam). Each crash state is rebuilt from a prefix of that trace, reopened, recovered by a fresh host, and checked with `checkDatabase` and the oracle. Two crash models:

- Process crash: one cut in the global order. The database must open and hold the whole committed log.
- Power loss: each store keeps its own prefix. The database must open and hold some log prefix (design.md, "Recovery"). Every pair is checked.

It covers three fixed workloads (ingest, compaction with reclaim, a two-step cascade), every pair of each, and 15 random single-handle histories with 40 sampled pairs each by default (about 15 s). Use `KV_CRASH_RUNS` and `KV_CRASH_PAIRS` for a longer sweep, `KV_CRASH_REPORT=1` to print how many states were checked, and the `KV_MODEL_*` variables to replay. A change to the write order or recovery should pass `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` (about 4 minutes).

The same file holds the churn tests: a tab whose run opens are slow while the host flushes and compacts before each one returns, a tab whose every file call is preceded by four flushes and a compaction, for 40 syncs, and a tab that keeps the reclaim lock while the host flushes and compacts. A healthy database must never report `CorruptDatabaseError`, and the host must never wait for the tab (design.md, "Loading a generation under churn").

`tests/sim/io-error.test.ts` fails fault site N for N = 1, 2, … until a run reaches no site N, with one-shot and persistent faults, over durable sites and read sites. Every call must settle, every resolved call must be right, and after healing the database must reopen with the whole committed log. `KV_IO_SITES=durable|read` runs one sweep, and `KV_IO_REPORT=1` prints its size and error names.

## Fuzz the decoders

Every decoder of on-disk or IndexedDB bytes is fuzzed against the rules of [the corruption research note](research/corruption-hardening-test-suite.md) ("Decisions", techniques 7, 8 and 10):

- Everywhere: corrupt or truncated bytes never hang, crash, panic in wasm, read out of bounds (in TypeScript, a `RangeError` from a `DataView`), allocate from a length field, or loop. An error is the documented one: `CorruptDatabaseError`, or `CommitError("corrupt wal row ...")` for a WAL row.
- Where a CRC is checked (manifests, and runs in the SharedWorker's compaction decode), changed bytes throw. They never decode, and never become lost data.
- Where none is (a tab's run reads, LZ4 unpack, block scans, WAL rows and `meta`), a wrong answer is allowed. Tabs keep skipping the SST CRC.

| Layer | Command | Runs in | Covers |
| --- | --- | --- | --- |
| Rust properties | `cargo test -p engine-core` | CI (`rust` job) | `decode_sst`, `scan_block_contains`, `merge_sst_bytes` on mutated runs, with an allocation counter (`crates/engine-core/tests/corrupt_inputs.rs`) |
| cargo fuzz | `crates/engine-core/fuzz/run.sh <target> [seconds]` | by hand | `decode_sst`, `scan_block_contains`, `compact` (libFuzzer, nightly) |
| TypeScript properties | `pnpm test` (`packages/kv/fuzz/decoders.test.ts`) | CI (`test` job) | `SstReader` (tab reads, wasm and fallback), `decodeSst`, `decodeGeneration` v1 and v2, `decodeOps`, `lz4DecompressJs` |
| Differential | `pnpm test` (`packages/kv/fuzz/differential.test.ts`) | CI (`test` job) | wasm against the TypeScript fallbacks: whole-run decode, block scan, LZ4 unpack, merge |
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

`pnpm test` runs 1,000 cases per mutation property, 300 per differential property, and a tenth of those for the slower ones. With the end-to-end file they take about 1 s. `KV_FUZZ_RUNS` and `ENGINE_PROP_CASES` scale them. `KV_FUZZ_REPORT=1` prints how often each target ran and each known bug skipped an input.

cargo fuzz needs `rustup toolchain install nightly` and `cargo install cargo-fuzz`. Jazzer.js is a dev dependency of `@opfs-lsm/kv`, with prebuilt binaries for macOS, Linux and Windows. Before a change to a decoder or the on-disk format, run each target for 10 minutes or more. A pass prints `Done N runs` and leaves no `crash-*` file.

Corpora: the seeds are files the engine wrote (a database through ingest and compaction on MemoryFs, plus wasm LZ4 runs). `pnpm --filter @opfs-lsm/kv fuzz:corpus` writes them again after a format change. Only `seed-*` files are tracked. A run adds its new inputs next to them, and git ignores those.

- `packages/kv/fuzz/corpus/<target>/` for Jazzer.js. A finding lands in `packages/kv/fuzz/.build/crash-*`. Replay it with `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> 0 <file>`.
- `crates/engine-core/fuzz/corpus/<target>/` for cargo fuzz. A finding lands in `crates/engine-core/fuzz/artifacts/<target>/`. Replay it with `cargo +nightly fuzz run <target> <file>`.

Known bugs are reported, not fixed. Each is pinned by a test that states the rule: `it.fails` in `packages/kv/fuzz/known-bugs.test.ts` and `tests/sim/corruption.test.ts`, and `#[ignore]` in `corrupt_inputs.rs` (`cargo test -p engine-core -- --ignored`). The fuzzers skip inputs that reach a known bug, so a long run keeps finding new ones. `KV_FUZZ_KNOWN=1` (TypeScript) and `ENGINE_FUZZ_KNOWN=1` (Rust) feed them too. When a fix lands, its pinned test starts to fail. Drop the `.fails` or `#[ignore]`, and delete the clause that skips it (`KNOWN` and `knownError` in `targets.ts`, `knownWasmBug` in `differential.test.ts`, `known_bug` in `corrupt.rs`).

### What the engine does with a corrupt file today

| File | Checked by | Corrupt bytes today |
| --- | --- | --- |
| L0 or L1 run (raw) | Tabs: none. Compaction: CRC. | A tab read fails with `CorruptDatabaseError` when the structure breaks, or answers wrong when only data bytes changed. Compaction refuses the run and stops compacting that level until the run is gone. With wasm it throws the Rust error as a bare string, not `CorruptDatabaseError` (KW2). A flipped bit in the footer's block count makes a tab allocate up to 32 GiB (KT2). A footer bloom hash count near 2^32 makes each get take minutes (KT1). |
| L2+ run (LZ4) | Tabs: none. Compaction: CRC. | A changed compressed byte fails the read with `CorruptDatabaseError`. A corrupt block size grows the tab's wasm memory by up to 4 GiB, for good (KB1). A filtered scan over a block with a varint near 2^32 panics in wasm (KW1). After about 4,000 panics every wasm call in that context fails (KW3). |
| Recorded manifest | CRC, everywhere | `openDb` throws `CorruptDatabaseError`. Then the SharedWorker's next flush reconciles, treats the manifest as missing, records generation 0, drops the WAL, and its sweep deletes every run. The database is erased (R2). A manifest written on purpose with a valid CRC and a bad length throws `RangeError` (KT4). |
| Manifest past the recorded one | CRC, recovery | Ignored. |
| A run of the recorded generation, missing | | `openDb` records generation 0, drops the WAL, and reads an empty database (R1). |
| WAL row above `ingestedThrough` | none | A row cut short, a row that is not an `ArrayBuffer`, or a missing row fails `openDb` with `CommitError` (`corrupt wal row`, `wal gap`). A row changed into other valid ops reads as those ops. |
| WAL `meta` | none | A value that is not a number reads as 0. With `head` 0 a tab misses the WAL tail. With `generation` naming no manifest, recovery records the intact one and loses nothing. |

Bugs reached only by bytes written on purpose, with a valid CRC: KB2 (`decode_sst` reserves the footer's entry count: an abort natively, a panic in wasm) and KT3 (`decodeSst` without wasm throws `RangeError` on a bad index). Over the SharedWorker port, every host error reaches the tab as a plain `Error` (`createPortIngestClient`), so a tab never sees `CorruptDatabaseError` from a host-side failure.

## Run the static checks

```sh
pnpm static
```

Exit 0. It runs `oxlint`, then `fallow dead-code`. Both fail on a new finding.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs six jobs on pull requests and on pushes to `main`:

- `bench`: `pnpm bench:size --check`, then `pnpm bench:smoke`
- `two-tab`: `pnpm --filter @opfs-lsm/kv two-tab`
- `test`: `pnpm test`
- `static`: `pnpm lint` and `pnpm deadcode` (oxlint, then fallow; the same two steps as `pnpm static`)
- `formal`: `pnpm --filter @opfs-lsm/kv formal:kv`
- `rust`: `cargo test -p engine-core`, which includes the corrupt-input properties

That workflow leaves out cargo fuzz, Jazzer.js, `two-tab-nobc`, `two-tab-local`, and full-size `pnpm bench` runs. The smoke proves every workload and contender still runs and reads correct values. It does not measure speed.

## Refresh a skill

Run [maintain-verification-skill](../.agents/skills/maintain-verification-skill/SKILL.md) when a browser-visible path changed and `verify-opfs-lsm/features/` was left behind: a new harness flag, a renamed proof string, a removed page, or a drive whose recipe no longer matches the page. That skill edits only the verify-opfs-lsm directory.

Run [maintain-formal-verification-skill](../.agents/skills/maintain-formal-verification-skill/SKILL.md) when code named in the verify-kv coverage record changed after the Sync commit and nobody re-ran `formal:kv` and moved that commit. That skill updates the models and the Sync commit. It leaves product code alone.

While you are changing product code and using verify-kv, follow that skill's "Intentional product change" steps instead: update `packages/kv/formal/`, run `formal:kv`, then set the Sync commit.

`create-verification-skill` and `create-formal-verification-skill` generate a new skill. Both verifiers already exist. Use the maintain skills to refresh them.

## Gaps

These exist on main and have no feature file and no formal check. Leave them out of the feature map until a maintain pass adds a recipe.

- `pendingBytes`, the ingest trigger in `packages/kv/src/host/engine-host.ts` and the WAL meta key of the same name in `packages/kv/src/idb/wal.ts`.
