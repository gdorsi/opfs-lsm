---
name: verify-opfs-lsm
description: "Drive real Chrome proofs for @opfs-lsm/kv and @opfs-lsm/collections — SharedWorker two-tab visibility, OPFS put/get/ingest benches, and collections table/index benches. Use when changing openDb, SharedWorker ingest, WAL/SST visibility across tabs, collections put/get/where, or any claim that MemoryFs unit tests alone cannot prove."
---

# Verify @opfs-lsm (real Chrome)

This skill proves browser behavior the way a integrating developer hits it: headless Chrome, IndexedDB WAL, OPFS SST files, SharedWorker ingest. It does **not** replace the formal suite in `verify-kv` (`pnpm --filter @opfs-lsm/kv formal:kv`). Use both: formal for exhaustive small models, this skill for the real stack.

Primary surface: repo-native Chrome harnesses under `packages/kv` and `packages/collections`. There is no product UI, CLI, or long-lived server. Secondary surfaces (unit tests with `MemoryFs`, formal checkers) are out of scope here.

Helper (always prefer this over raw `pnpm` so evidence lands in one place):

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm <doctor|launch|drive|cleanup>
```

## Launch

Build once per verification session. Harnesses are short-lived: each drive starts its own HTTP server on `127.0.0.1:0`, a disposable Chrome profile, and exits.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
```

Ready when `doctor` prints `doctor: ok` (node ≥22, pnpm, Chrome, wasm present, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/collections/dist/index.js`).

Equivalent without the helper:

```sh
pnpm install
pnpm --filter @opfs-lsm/kv build
pnpm --filter @opfs-lsm/collections build
```

Chrome: `CHROME_PATH` when set, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, else `google-chrome` on `PATH`.

Teardown is per-drive (Chrome kill + server close inside the harness). After the session, run `cleanup` for any leftover fixed bench profiles.

## Doctor

Read-only health check. Run first whenever a drive fails or the checkout looks stale.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
```

Require: `doctor: ok`. Warnings about `.bench-chrome-profile` mean another bench may own that fixed path — do not start a second `kv-bench` or `collections-bench` in the same checkout.

## Drive

Read `features/README.md`, then the feature file. Drive through the helper so stdout/stderr/exit land under `artifacts/`.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive kv-bench
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive collections-bench
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive automerge-bench
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive yjs-bench
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-nobc
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-local
```

Harness mapping (repo-native; do not invent a second browser stack):

| Feature id | Command the helper runs |
|---|---|
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `kv-bench` | `BENCH_N=50 pnpm bench:browser` (override with `BENCH_N`) |
| `collections-bench` | `BENCH_N=50 pnpm bench:collections` |
| `automerge-bench` | `BENCH_RUNS=1 BENCH_LOADS=2 BENCH_WORKLOADS=trace:100,data/moby-dick.automerge pnpm --filter @opfs-lsm/example-automerge bench:big-doc` |
| `yjs-bench` | `DOCS=100 RUNS=1 pnpm --filter @opfs-lsm/example-yjs bench:load` |

Stable proof strings (from harness stdout, not DOM coordinates):

- Two-tab SharedWorker: `tabs=2`, `mode=SharedWorker`, `two-tab ok`, exit `0`.
- Two-tab local: `tabs=1`, `mode=local EngineHost`, `two-tab ok`, exit `0`.
- KV bench: lines `kv solitary put`, `kv one batch`, `kv point get (warm)`, `kv ingest → OPFS`, `kv point get (post-ingest)`, exit `0` (no `kv FAILED`).
- Collections bench: `collections solitary put`, `collections get by id`, `collections where email`, exit `0`.
- Automerge bench: one `== <workload>` table per workload with `kv`, `idb` and `mem` columns, each followed by `checks: goodLoads N/N, errors 0`, exit `0`.
- Yjs bench: `load <DOCS> random docs of <DOCS*10>` table with `kv`, `kv-wal`, `kv-sst`, `idb` cold and warm rows, every `checked` equal to DOCS, exit `0`.

Pages (served only while a drive runs): `#run` / `#out` in `packages/kv/bench/two-tab.html`, `packages/kv/bench/browser.html`, `packages/collections/bench/browser.html`. Auto mode uses `?auto=1`; agents should not click `Run` unless debugging a hung auto session.

## Evidence

Proof root (survives cleanup):

```
.agents/skills/verify-opfs-lsm/artifacts/<feature>/<run-id>/
  meta.txt          # cwd, command, timestamps, exit
  stdout.txt
  stderr.txt
  exit_code.txt
```

Override with `VERIFY_OPFS_ARTIFACTS` / `VERIFY_OPFS_RUN_ID`.

Proof standards:

- Exercise the SharedWorker + OPFS path (default harness). `MemoryFs`, `forceMemory`, and vitest alone do not count as browser proof.
- Capture the action log and the resulting assertions the harness already prints (`two-tab ok`, post-ingest gets), not only exit code.
- Side effects the harness checks: cross-tab get after put, pinned view across peer ingest, range after ingest, warm and post-ingest point gets. Do not stub IndexedDB/OPFS/SharedWorker.
- Timing rows are evidence of a completed path; they are not a performance gate unless the feature file says so (`bench:gate` is separate).

## Cleanup

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

Removes only `packages/kv/.bench-chrome-profile` and `packages/collections/.bench-chrome-profile`. Does **not** delete `artifacts/`. Does **not** kill Chrome by process name — harnesses already `SIGKILL` the child they spawned. If a drive was interrupted mid-Chrome, run `cleanup`, then `doctor`, then retry one feature.

## Isolation

- `two-tab` uses a unique tmp Chrome profile and ephemeral ports — parallel two-tab runs are fine.
- `kv-bench` / `collections-bench` use a **fixed** `.bench-chrome-profile` under that package. The helper refuses to start if the profile directory already exists. Never double-drive those benches in one checkout.
- Do not attach to a Chrome the user already has open for this origin; always use the harness-spawned headless instance.

## Helpers

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

Formal properties (NoLostAcks, WalOverSst, ViewPin, CompactPreserve): use `.agents/skills/verify-kv/SKILL.md`, not this skill.

## Feature map

See [features/README.md](./features/README.md). A proof that drives only one convenient entry point is incomplete when the map lists others for the change under test.
