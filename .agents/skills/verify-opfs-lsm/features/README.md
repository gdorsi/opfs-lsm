# @opfs-lsm browser verification map

This directory is the maintained source for verifying real-Chrome behavior of `@opfs-lsm/kv` and `@opfs-lsm/docstore`. Read the index before driving, then use the matching feature file as the recipe.

Formal model checkers live under `verify-kv` and are not listed here.

## Baseline preconditions

- Repo root is the workspace that contains `packages/kv` and `packages/docstore`.
- Run `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm launch` once so dist + wasm are present.
- Run `doctor` and require `doctor: ok`.
- Drive only through `verify-opfs-lsm drive …` so evidence lands under `artifacts/`.
- Never attach to a user Chrome session.

## Driving conventions

- Prefer the SharedWorker path (default). Opt into `two-tab-local` only when proving the in-page `EngineHost` path.
- Treat harness stdout as the user-visible proof log (`#out` content posted to `/two-tab-results`, and the bench report tables).
- Keep env flags literal: `TWO_TAB_NOBC=1`, `TWO_TAB_LOCAL=1`.
- Every harness closes its Chrome and uses a fresh temp profile, so there is no profile to clean up.
- Do not delete `artifacts/` during cleanup.

## Proof and skip reporting

- Capture stdout that includes both the action lines and the final ok / timing lines.
- Require exit code `0` and the feature-specific proof strings in the feature file.
- The m1-smoke workflow runs `two-tab` and `bench:smoke`. It omits `two-tab-nobc`, `two-tab-local`, and the full bench families. [docs/verification.md](../../../../docs/verification.md) lists what CI runs.
- Record the feature id and the helper command in `meta.txt` (the helper writes this).
- Report an unreachable path with the unmet precondition (missing Chrome, missing dist).
- Do not claim SharedWorker proof from a `TWO_TAB_LOCAL=1` or `MemoryFs` run.

## Feature entry contract

Each feature file starts with an H1 and one paragraph of user-visible behavior, then exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-opfs-lsm`, `Gotchas`.

## Features

- [Two-tab SharedWorker visibility](./two-tab.md) — peer put/get/ingest across two tabs.
- [Benchmark suite](./bench.md) — `pnpm bench <family>/` for kv vs IndexedDB, docstore vs Dexie, the Automerge adapter, and Yjs `KvPersistence`, with every read checked; `bench-smoke` for all of them at size `tiny`.
- [Two-tab without BroadcastChannel](./two-tab-nobc.md) — same scenario with BC silenced.
- [Two-tab local EngineHost](./two-tab-local.md) — one page, two handles, no SharedWorker.
- [Size cap across two tabs](./pressure.md) — `maxBytes` offers answered by one tab's handler, and the warning when no tab has one.
