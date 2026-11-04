# KV OPFS put/get/ingest bench

The KV bench opens `@opfs-lsm/kv` in headless Chrome on a SharedWorker + OPFS path, writes N keys, checks warm gets, ingests to SST, checks post-ingest gets, and optionally times Dexie on the same origin.

## Sub-features

- `kv-solitary-put` acks N solitary puts through the IndexedDB WAL.
- `kv-batch` writes one batch of N puts.
- `kv-warm-get` point-gets the solitary keys before ingest.
- `kv-ingest` publishes WAL rows to an OPFS SST.
- `kv-post-ingest-get` point-gets the same keys after ingest.
- `kv-dexie-compare` times Dexie solitary put, bulkPut, and point get (Dexie failure is logged but does not fail the kv path).

## How to get to it (user POV)

- Run `pnpm bench:browser` from the monorepo root (or the helper drive).
- Or open the served `packages/kv/bench/browser.html?auto=1&n=50` and read `#out`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.
- `packages/kv/.bench-chrome-profile` does not exist (helper refuses otherwise).

- **Run the bench.** Execute `BENCH_N=50 .agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive kv-bench` (helper defaults `BENCH_N` to 50). Exit code `0`.
- **Confirm SharedWorker.** Stdout contains `mode=SharedWorker + BrowserFs (OPFS)`.
- **Confirm kv path.** Stdout contains timed lines for `kv solitary put`, `kv one batch`, `kv point get (warm)`, `kv ingest → OPFS`, and `kv point get (post-ingest)`.
- **Confirm no kv failure.** Stdout does not contain `kv FAILED`.
- **Proof.** Keep `artifacts/kv-bench/<run-id>/stdout.txt`. Timing numbers may vary by machine; presence of all five kv rows plus exit `0` is the proof.

## Gotchas

- The Chrome profile path is fixed under `packages/kv/.bench-chrome-profile`. Concurrent benches in one checkout corrupt isolation — the helper refuses a second start.
- `BENCH_LOCAL=1` uses in-page `EngineHost` and is not SharedWorker proof.
- Dexie errors after a successful kv path do not fail the harness; still require the kv rows.
- Do not use `--virtual-time-budget`; the harness intentionally uses real wall clock so IDB/OPFS are not starved.
