---
name: verify-opfs-lsm
description: "Drive real Chrome proofs for @opfs-lsm/kv and @opfs-lsm/docstore — SharedWorker two-tab visibility and the bench/ suite (kv vs IndexedDB, docstore vs Dexie, Automerge and Yjs adapters, every read checked). Use when changing openDb, SharedWorker ingest, WAL/SST visibility across tabs, docstore put/get/query, the Automerge or Yjs adapters, or any claim that MemoryFs unit tests alone cannot prove."
---

# Verify @opfs-lsm (real Chrome)

This skill proves browser behavior the way a integrating developer hits it: headless Chrome, IndexedDB WAL, OPFS SST files, SharedWorker ingest. It does **not** replace the formal suite in `verify-kv` (`pnpm --filter @opfs-lsm/kv formal:kv`). Use both: formal for exhaustive small models, this skill for the real stack.

Primary surface: repo-native Chrome harnesses: the two-tab proof in `packages/kv` and the benchmark suite in `bench/`. There is no product UI, CLI, or long-lived server. Secondary surfaces (unit tests with `MemoryFs`, formal checkers) are out of scope here.

Helper (always prefer this over raw `pnpm` so evidence lands in one place):

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm <doctor|launch|drive|cleanup>
```

## Launch

Build once per verification session. Harnesses are short-lived: each drive starts its own HTTP server on `127.0.0.1:0`, a disposable Chrome profile, and exits.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch
```

Ready when `doctor` prints `doctor: ok` (node ≥22, pnpm, Chrome, wasm present, `packages/kv/dist/index.js`, `packages/kv/dist/host/shared-worker.js`, `packages/docstore/dist/index.js`).

Equivalent without the helper:

```sh
pnpm install
pnpm --filter @opfs-lsm/kv build
pnpm --filter @opfs-lsm/docstore build
```

Chrome: `CHROME_PATH` when set, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, else `google-chrome` on `PATH`.

Teardown is per-drive (Chrome kill + server close inside the harness). Every harness uses a fresh temp Chrome profile.

## Doctor

Read-only health check. Run first whenever a drive fails or the checkout looks stale.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm doctor
```

Require: `doctor: ok`.

## Drive

Read `features/README.md`, then the feature file. Drive through the helper so stdout/stderr/exit land under `artifacts/`.

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench kv/
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench table/
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench automerge/
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench yjs/
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench-smoke
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-nobc
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive two-tab-local
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive pressure
```

Harness mapping (repo-native; do not invent a second browser stack):

| Feature id | Command the helper runs |
|---|---|
| `two-tab` | `pnpm --filter @opfs-lsm/kv two-tab` |
| `two-tab-nobc` | `TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `two-tab-local` | `TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `pressure` | `TWO_TAB_PRESSURE=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts` |
| `bench <args…>` | `pnpm bench <args…>`: a selector (`kv/`, `table/`, `automerge/`, `yjs/`, or one workload such as `kv/fillrandom`) plus optional `--size`, `--reps`, `--contenders` |
| `bench-smoke` | `pnpm bench:smoke` |

Stable proof strings (from harness stdout, not DOM coordinates):

- Two-tab SharedWorker: `tabs=2`, `mode=SharedWorker`, `two-tab ok`, exit `0`.
- Two-tab local: `tabs=1`, `mode=local EngineHost`, `two-tab ok`, exit `0`.
- Size cap: `tabs=2`, `mode=SharedWorker`, `pressure answered by tab`, `both tabs read`, `no handler: one warning in each tab`, `pressure ok`, exit `0`.
- Bench and bench-smoke: one `## <family>/<workload>: <title>` section per workload with a row per contender, no `## Failed runs` section, exit `0`. Every read is checked against a model, so exit `0` means every value was right.

Pages (served only while a drive runs): `#run` / `#out` in `packages/kv/proof/two-tab.html`. Auto mode uses `?auto=1`; agents should not click `Run` unless debugging a hung auto session. The bench pages are built into `bench/.out` and driven by `bench/cli.ts`.

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
- Timing rows are evidence of a completed path. A performance claim needs `--reps 5` or more and `node bench/cli.ts compare` (see `features/bench.md`).

## Cleanup

```sh
.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm cleanup
```

Removes nothing on disk: every harness uses a fresh temp profile. Does **not** delete `artifacts/`. Does **not** kill Chrome by process name — harnesses already `SIGKILL` the child they spawned. If a drive was interrupted mid-Chrome, run `cleanup`, then `doctor`, then retry one feature.

## Isolation

- `two-tab` and `bench` each use a unique tmp Chrome profile and ephemeral ports — parallel runs do not collide on disk.
- Run benches one at a time anyway, so a second Chrome does not skew the timings.
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
