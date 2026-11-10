# Benchmark suite, kv and its integrations against IndexedDB baselines

The suite in `bench/` runs each workload in headless Chrome against every contender of its family, through the same family interface. Every read is checked against an in-memory model, so a wrong value fails the run. A drive is a correctness proof first. It is a performance claim only with enough reps and a compare.

## Sub-features

- `kv/` compares `kv/kv` (`@opfs-lsm/kv` on SharedWorker + OPFS) with `kv/idb` (raw IndexedDB). Workloads: `fillseq`, `fillrandom`, `fillsync`, `overwrite`, `deleterandom`, `ycsb-a` to `ycsb-f`.
- `table/` compares `table/docstore` with `table/dexie` on one todo table with an owner index and a createdAt index (`table/todos`).
- `automerge/` compares the kv storage adapter (`automerge/kv`) with `IndexedDBStorageAdapter` (`automerge/idb`). Workloads: `trace`, `many-docs`.
- `yjs/` compares `KvPersistence` (`yjs/kv`) with y-indexeddb (`yjs/y-indexeddb`). Workloads: `trace`, `many-docs`.
- `bench-smoke` runs every workload against every contender at size `tiny`, 1 rep. It checks correctness and harness health, not speed.

## How to get to it (user POV)

- Run `pnpm bench <selector…> [--size tiny|small|large] [--reps N] [--contenders a,b] [--headed]` from the repo root. A selector is a family (`kv/`) or one workload (`kv/fillrandom`). No selector runs everything. The defaults are `--size small` and `--reps 5`.
- Run `pnpm bench:smoke` for the CI smoke.
- Results land in `bench/results/<stamp>-<host>.jsonl` with a `.md` report beside them. Both are gitignored.
- Compare two result files with `node bench/cli.ts compare a.jsonl b.jsonl`. Reprint one with `node bench/cli.ts report a.jsonl`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok`.

- **Run the family.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench kv/` (or `table/`, `automerge/`, `yjs/`). Add `--size tiny --reps 1` for a fast correctness check. The helper passes every argument after `bench` to `pnpm bench`. Exit code `0`.
- **Run the smoke.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive bench-smoke`. Exit code `0`.
- **Confirm tables.** Stdout has one `## <family>/<workload>: <title>` section per selected workload. Each section has a phase table with a row per contender (`phase | contender | runs | ops/s | …`). kv workloads that record a footprint also print an amplification table.
- **Confirm no failure.** Stdout has no `## Failed runs` section and no `problem(s):` line on stderr.
- **Performance claim.** Run with `--reps 5` or more, before and after the change, then run `node bench/cli.ts compare before.jsonl after.jsonl`. Report only rows whose verdict is `B faster` or `B slower`. `≈ no measurable difference` means the ranges overlap.
- **Proof.** Keep `artifacts/bench/<run-id>/stdout.txt` (or `artifacts/bench-smoke/…`) and the `bench/results/*.md` file that stdout names on its first line.

## Gotchas

- Each run uses a fresh temp Chrome profile and its own server, so drives do not collide on disk. Run one at a time anyway, so timings are not shared with another Chrome.
- `pnpm bench` builds every package under `packages/` first. A build error fails the drive before Chrome opens.
- One wrong read fails that run and the whole command exits 1. The other runs still print. Read the `## Failed runs` list for the workload and contender.
- `--size large` takes much longer. Use it only when the claim is about large data.
- Timings at size `tiny` or with 1 rep are not evidence of speed.
