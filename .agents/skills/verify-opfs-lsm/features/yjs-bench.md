# Yjs many documents, kv vs y-indexeddb

An app keeps many Yjs documents and opens a few of them. The bench writes `DOCS * 10` notes, each stored as `EDITS` updates, then loads `DOCS` of them picked at random. It runs that through `KvPersistence` on `@opfs-lsm/kv` (SharedWorker + OPFS, all documents in one db) and through y-indexeddb's `IndexeddbPersistence` (one IndexedDB database per document, its default). Every load must return the title and body that were written.

## Sub-features

- `yjs-write` writes the whole set once per storage. `kv-sst` then calls `db.ingest()`, so its loads read SSTs; `kv-wal` keeps every update in the WAL.
- `yjs-cold-load` reloads the page, opens fresh storage, and loads the sample with `CONCURRENCY` loads in flight.
- `yjs-warm-load` repeats the load on the same page.

## How to get to it (user POV)

- Run `pnpm bench:yjs` (or the helper drive).
- Size it with `DOCS` (sample size; the set is ten times that), `RUNS` (page reloads), `CONCURRENCY`, `EDITS`. `BENCH_OUT=<file>` keeps the raw JSON.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run the bench.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive yjs-bench`. The helper defaults to `DOCS=100 RUNS=1`. Exit code `0`.
- **Confirm loads round-trip.** The `load` table has `kv-wal`, `kv-sst` and `idb` rows for `cold` and `warm`, and every `checked` equals `DOCS`. A wrong document fails the page with `documents loaded wrong`.
- **Proof.** Keep `artifacts/yjs-bench/<run-id>/stdout.txt`. For a performance claim, rerun at the default size (`DOCS=5000`, a 50k set) with `RUNS=5` or more and compare medians and the per-run line, not one run.

## Gotchas

- y-indexeddb writes one extra update per document on every open, so its warm pass reads one more update than its cold pass. That is its default behaviour, not a bench artifact.
- `kv-wal` open time grows with the WAL: its `open ms` is WAL replay of the whole set, not of the sample.
- Each run uses a fresh temp Chrome profile. The bench rebuilds `@opfs-lsm/kv` first.
- Don't run it alongside another Chrome bench. CPU contention moves the timings.
