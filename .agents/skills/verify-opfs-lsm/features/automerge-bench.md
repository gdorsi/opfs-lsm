# Automerge big document, kv vs IndexedDB

An app using Automerge Repo with `kvStorage` writes one big document and loads it back. The bench runs that through `@opfs-lsm/kv` (SharedWorker + OPFS), Automerge's `IndexedDBStorageAdapter`, and an in-memory adapter. Every reload must return the heads and text that were written. The in-memory column is Automerge's own cost, so a gap between kv and idb is storage.

## Sub-features

- `automerge-trace-write` replays Automerge's 260k-keystroke editing trace (`trace:<n>`, `n` keystrokes per change), letting Repo's save debounce fire mid-replay.
- `automerge-import-write` imports a saved document whole (`data/moby-dick.automerge`, `data/essay.amrg`).
- `automerge-cold-load` opens new storage and a new Repo, finds the doc, and compares heads and text with what was written.
- `automerge-open` times opening storage after Chrome's first storage touch in the profile.

## How to get to it (user POV)

- Run `pnpm --filter @opfs-lsm/example-automerge bench:big-doc` (or the helper drive).
- Inputs come from automerge's `rust/benchmark-battery` at a pinned commit and download once into `examples/automerge-todo/bench-data/`.
- Size it with `BENCH_RUNS`, `BENCH_LOADS`, `BENCH_WORKLOADS` (comma list), and `BENCH_KV_WAL` for kv ingest triggers.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.
- Network access on the first run, or `examples/automerge-todo/bench-data/` already populated.

- **Run the bench.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive automerge-bench`. The helper defaults to 1 run, 2 loads, `trace:100,data/moby-dick.automerge`. Exit code `0`.
- **Confirm every workload ran.** Stdout has an `== <workload>` table per workload with `kv`, `idb` and `mem` columns and no `NaN` medians.
- **Confirm loads round-trip.** Each workload ends with `checks: goodLoads N/N, errors 0`.
- **Proof.** Keep `artifacts/automerge-bench/<run-id>/stdout.txt`. For a performance claim, rerun with `BENCH_RUNS=5` or more and compare medians and ranges, not one run.

## Gotchas

- Each run uses a fresh temp Chrome profile, so runs are isolated and leave no fixed profile behind.
- The bench rebuilds `@opfs-lsm/kv` first, so it always measures the current source.
- `data/unsinkable.amrg` (19 MB) and larger docs run Automerge's WASM out of memory on every adapter. That says nothing about storage.
- Don't run it alongside another Chrome bench. CPU contention moves the timings.
