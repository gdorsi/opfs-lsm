# Verify a change

This page is the source of truth for proving a change to `@opfs-lsm/kv` and `@opfs-lsm/collections`. The procedures live in two skills. `.claude/skills/` symlinks the same directories under `.agents/skills/`.

- [verify-kv](../.agents/skills/verify-kv/SKILL.md) checks small exhaustive models of WAL visibility, point get, view pins, and SST merge.
- [verify-opfs-lsm](../.agents/skills/verify-opfs-lsm/SKILL.md) drives headless Chrome. The feature recipes are in [features/](../.agents/skills/verify-opfs-lsm/features/README.md).

`create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, and `maintain-formal-verification-skill` generate or refresh those skills. Run a maintain skill only in the cases under [Refresh a skill](#refresh-a-skill).

## Pick the check

Run every row that matches the diff. When several rows match, run `formal:kv`, then the Chrome drives those rows name, then `pnpm test`.

| Change | Run |
| --- | --- |
| WAL append or ack, `ingestAll`, `listUningested`, `advanceIngested` | `pnpm --filter @opfs-lsm/kv formal:kv` (or at least `formal:ingest-visibility`) |
| Point get versus SST, including tombstones (`pointGet`, `readKey`) | `formal:wal-over-sst`. Add `kv-bench` when the OPFS read after ingest changed. |
| `view()` or the memtable pin | `formal:view-pin` |
| SST merge, compaction, or the on-disk format those paths read (`latestSstEntry`, `foldEntries`, `mergeSsts`) | `formal:compact-preserve`, plus `kv-bench` for a real post-ingest get |
| `openDb`, the SharedWorker, or cross-tab visibility | `drive two-tab` |
| BroadcastChannel wiring | `drive two-tab` and `drive two-tab-nobc`. See [Failures already on main](#failures-already-on-main). |
| In-page `EngineHost` | `drive two-tab-local`. See [Failures already on main](#failures-already-on-main). |
| Collections `put`, `get`, or `where` | `drive collections-bench`. See [Failures already on main](#failures-already-on-main). |
| Any TypeScript behavior | `pnpm test` |

`pendingBytes` and the example load/open benches have no check. See [Gaps](#gaps).

## Run the Chrome proofs

From the repo root, in this order:

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive <feature>
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

`<feature>` is one of `two-tab`, `two-tab-nobc`, `two-tab-local`, `kv-bench`, `collections-bench`. Drive each feature that the table above names. Run `doctor` again after a drive that fails, then `cleanup`, before the next drive.

`launch` installs dependencies when `node_modules` is missing, builds `@opfs-lsm/kv` and `@opfs-lsm/collections`, and runs `doctor`. A checkout with no `dist` fails the first `doctor` (`kv dist: MISSING`). `launch` is the repair.

A healthy doctor prints `doctor: ok` and exits 0. It requires Node `>=22`, pnpm, Chrome (`CHROME_PATH`, otherwise `google-chrome` on `PATH`, otherwise the macOS app path), `packages/kv/wasm/engine_wasm_bg.wasm`, `packages/kv/wasm/engine_wasm.js`, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/collections/dist/index.js`, and `node_modules`.

The helper runs:

| Feature | Command |
| --- | --- |
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `kv-bench` | `BENCH_N=50 pnpm bench:browser` |
| `collections-bench` | `BENCH_N=50 pnpm bench:collections` |

A passing drive prints `drive: ok evidence=...` and exits 0. `exit_code.txt` is `0`. Stdout contains the proof strings:

| Feature | Proof strings |
| --- | --- |
| `two-tab` | `tabs=2`, `mode=SharedWorker`, `two-tab ok` |
| `two-tab-nobc` | `mode=SharedWorker nobc`, `two-tab ok`, and `bc_posts=` with a positive count |
| `two-tab-local` | `tabs=1`, `mode=local EngineHost`, `two-tab ok` |
| `kv-bench` | `mode=SharedWorker + BrowserFs (OPFS)`, `kv solitary put`, `kv one batch`, `kv point get (warm)`, `kv ingest → OPFS`, `kv point get (post-ingest)`. Stdout has no `kv FAILED` line. |
| `collections-bench` | `mode=SharedWorker + BrowserFs (OPFS)`, `collections solitary put`, `collections get by id`, `collections where email` |

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

Exit 0. The log ends with `All 4 formal checks passed`. Each check prints a `PASS` line:

- `PASS NoLostAcks`
- `PASS WalOverSst` (on real `pointGet`)
- `PASS ViewPin` (copy-on-write memtable pin present)
- `PASS CompactPreserve` (`latestSstEntry` newest-first, `foldEntries` oldest-first)

The same checks have their own scripts: `formal:ingest-visibility`, `formal:wal-over-sst`, `formal:view-pin`, `formal:compact-preserve`. Each exits 0 on a pass. A failure prints a shortest path or a counterexample and exits non-zero.

The Sync commit in `verify-kv` is the commit where those models were last confirmed against the code they name. The current value is `682b4d8a8118065340ea30d9bd83142d264fb2a3`. Move it only after `formal:kv` passes and you have checked that the models still describe the code. Set it to `git rev-parse HEAD` of that confirmation. A docs-only commit does not move it.

`pendingBytes` is outside the model. A pass says nothing about the ingest trigger.

## Run the unit tests

```sh
pnpm test
```

Exit 0. The root script checks that `README.md` still contains its required phrases, builds the workspace, and runs the `@opfs-lsm/kv` and `@opfs-lsm/collections` unit suites.

## What CI runs

[`.github/workflows/m1-smoke.yml`](../.github/workflows/m1-smoke.yml) runs on pull requests and on pushes to `main`:

- `pnpm bench:gate` with `BENCH_GATE_BROWSER=smoke`
- `pnpm --filter @opfs-lsm/kv two-tab`
- `pnpm test`
- `pnpm --filter @opfs-lsm/kv formal:kv`

That workflow leaves out `two-tab-nobc`, `two-tab-local`, `kv-bench`, `collections-bench`, `bench:load`, and `bench:open`. `bench:gate` is the performance smoke. It is separate from `kv-bench`.

## Failures already on main

The feature files still describe the intended proof (exit 0 and the strings above). On `main` these three drives miss that bar. A log that matches the text below is the baseline. Treat it as a new regression only when the error text changes, or when the diff is the path that drive exists to prove.

| Drive | Result on main | CI |
| --- | --- | --- |
| `two-tab-local` | Exit 1. The page reports `pinned get before ingest was null`. | Absent |
| `two-tab-nobc` | Exit 1. Same message, before `two-tab ok`. `view()` pins the tab memtable, and this drive silences the BroadcastChannel that copies a peer append into that memtable. | Absent |
| `collections-bench` | Exit 1. The page reports `Failed to resolve module specifier '@opfs-lsm/collections/testing'`. `packages/collections/bench/browser.html` has no import-map entry for that specifier. `packages/collections/dist/testing.js` is present after `launch`. | Absent |

`two-tab` and `kv-bench` meet the pass bar above. Require them when the matching row in [Pick the check](#pick-the-check) applies.

## Refresh a skill

Run [maintain-verification-skill](../.agents/skills/maintain-verification-skill/SKILL.md) when a browser-visible path changed and `verify-opfs-lsm/features/` was left behind: a new harness flag, a renamed proof string, a removed page, or a drive whose recipe no longer matches the page. That skill edits only the verify-opfs-lsm directory.

Run [maintain-formal-verification-skill](../.agents/skills/maintain-formal-verification-skill/SKILL.md) when code named in the verify-kv coverage record changed after the Sync commit and nobody re-ran `formal:kv` and moved that commit. That skill updates the models and the Sync commit. It leaves product code alone.

While you are changing product code and using verify-kv, follow that skill's "Intentional product change" steps instead: update `packages/kv/formal/`, run `formal:kv`, then set the Sync commit.

`create-verification-skill` and `create-formal-verification-skill` generate a new skill. Both verifiers already exist. Use the maintain skills to refresh them.

## Gaps

These exist on main and have no feature file and no formal check. Leave them out of the feature map until a maintain pass adds a recipe.

- `pendingBytes`, the ingest trigger in `packages/kv/src/host/engine-host.ts` and the WAL meta key of the same name in `packages/kv/src/idb/wal.ts`.
- `pnpm --filter @opfs-lsm/example-automerge bench:load` (`examples/automerge-todo/scripts/bench-load.ts`) and `pnpm --filter @opfs-lsm/example-automerge bench:open` (`examples/automerge-todo/scripts/bench-open.ts`). Both are headless Chrome benches. They are outside `verify-opfs-lsm/features/`.
