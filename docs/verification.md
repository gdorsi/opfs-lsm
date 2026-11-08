# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/collections`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of WAL visibility, point get, view pins, SST merge, and power-loss recovery.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| WAL append or ack, `ingestAll`, `listUningested`, `advanceIngested` | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility` and `formal:power-loss`) |
| The write order of ingest, compaction install or reclaim, `reconcile`, `IdBWal.adopt`, manifest numbering, or the open path | `formal:power-loss`, then `tests/sim/crash-enum.test.ts` with a long sweep (below) |
| Point get versus SST, including tombstones (`pointGet`, `readKey`) | `formal:wal-over-sst`. Add `kv-bench` when the OPFS read after ingest changed. |
| `view()` or the memtable pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, `foldEntries`, `mergeSsts`) | `formal:compact-preserve`, plus `kv-bench` for a real post-ingest get |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| `examples/automerge-todo/src/storage.ts`, or a kv change claimed to speed up Automerge | `drive automerge-bench`. For a performance claim, rerun with `BENCH_RUNS=5` and compare medians and ranges. |
| `examples/yjs/src/kv-persistence.ts`, or a kv change claimed to speed up Yjs | `drive yjs-bench`. For a performance claim, rerun with `DOCS=5000 RUNS=5` (a 50k set) and compare medians and ranges. |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. |
| In-page `EngineHost` | `drive two-tab-local`. |
| Collections `put`, `get`, or `where` | `drive collections-bench`. See [Failures already on main](#failures-already-on-main). |
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

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH` when set, otherwise `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, otherwise `google-chrome` on `PATH`), `packages/kv/wasm/engine_wasm_bg.wasm`, `packages/kv/wasm/engine_wasm.js`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/collections/dist/index.js`, and `node_modules`.

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
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-tab ok`, and `bc_posts=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local EngineHost`, `two-tab ok` |
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

The same checks have their own scripts: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`, `formal:power-loss`. `FORMAL_POWER_CMDS` (default 6) and `FORMAL_POWER_CRASHES` (default 2) widen the power-loss bound; 7 commands or 3 crashes take about 11 s. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `4f56f230900213d955efb7ec3552441bb83b1d6c`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

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

`tests/sim/multi-handle.test.ts` does the same over three handles that share one host, one MemoryFs and one fake-indexeddb, with handles opening and closing. Ops of different handles overlap, and an `fc.scheduler` picks the order of BroadcastChannel deliveries (which can also be dropped), file calls and pauses inside views and ranges (`tests/sim/multi.ts`). The recorded history is checked seq-exactly by `tests/sim/history.ts`: every read is a log prefix, each handle's prefix never goes back, read-your-writes at ack, `sync()` and open are barriers, a view reads one prefix, and an `update` reads exactly the state before its own seq, so concurrent increments lose nothing. It does not check that a handle sees another handle's write without `sync()`, because the design does not promise it. It runs 100 + 100 histories by default (a few seconds) and takes the same `KV_MODEL_*` variables; `KV_SIM_TRACE=1` prints every scheduled task and op. A command stalls a handle's run opens, so a slow catch-up can finish after a newer generation was installed.

`tests/sim/crash-enum.test.ts` enumerates crash states. A workload runs once with every durable op traced: OPFS file creates, publishes and removes (`tests/sim/fault-fs.ts`, an `AsyncFs` wrapper), and IndexedDB commits (`tests/sim/fault-wal.ts`, a wrapper on fake-indexeddb's object store, with no product seam). Each crash state is rebuilt from a prefix of that trace, reopened, recovered by a fresh host, and checked with `checkDatabase` and the oracle. Two crash models:

- Process crash: one cut in the global order. The database must open and hold the whole committed log.
- Power loss: each store keeps its own prefix. The database must open and hold some log prefix (design.md, "Recovery"). Every pair is checked.

It covers three fixed workloads (ingest, compaction with reclaim, a two-step cascade), every pair of each, and 15 random single-handle histories with 40 sampled pairs each by default (about 15 s). Use `KV_CRASH_RUNS` and `KV_CRASH_PAIRS` for a longer sweep, `KV_CRASH_REPORT=1` to print how many states were checked, and the `KV_MODEL_*` variables to replay. A change to the write order or recovery should pass `KV_CRASH_RUNS=300 KV_CRASH_PAIRS=200` (about 4 minutes).

`tests/sim/io-error.test.ts` fails fault site N for N = 1, 2, … until a run reaches no site N, with one-shot and persistent faults, over durable sites and read sites. Every call must settle, every resolved call must be right, and after healing the database must reopen with the whole committed log. `KV_IO_SITES=durable|read` runs one sweep, and `KV_IO_REPORT=1` prints its size and error names.

## Run the static checks

```sh
pnpm static
```

Exit 0. It runs `oxlint`, then `fallow dead-code`. Both fail on a new finding.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs five jobs on pull requests and on pushes to `main`:

- `gate`: `pnpm bench:gate` with `BENCH_GATE_BROWSER=smoke`
- `two-tab`: `pnpm --filter @opfs-lsm/kv two-tab`
- `test`: `pnpm test`
- `static`: `pnpm lint` and `pnpm deadcode` (oxlint, then fallow; the same two steps as `pnpm static`)
- `formal`: `pnpm --filter @opfs-lsm/kv formal:kv`

That workflow leaves out `two-tab-nobc`, `two-tab-local`, `kv-bench`, `collections-bench`, `automerge-bench`, `yjs-bench`, `bench:load`, and `bench:open`. `bench:gate` is the performance smoke. It is separate from `kv-bench`.

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

- `pendingBytes`, the ingest trigger in `packages/kv/src/host/engine-host.ts` and the WAL meta key of the same name in `packages/kv/src/idb/wal.ts`.
- `pnpm --filter @opfs-lsm/example-automerge bench:load` (`examples/automerge-todo/scripts/bench-load.ts`) and `pnpm --filter @opfs-lsm/example-automerge bench:open` (`examples/automerge-todo/scripts/bench-open.ts`). Both are headless Chrome benches. They are outside `verify-opfs-lsm/features/`.
