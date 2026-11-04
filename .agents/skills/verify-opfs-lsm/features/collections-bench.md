# Collections table and email index

The collections bench opens a `users` table with an `email` index on `@opfs-lsm/collections` in headless Chrome, puts N rows through the SharedWorker path, gets by id and `where("email")`, ingests, and re-checks where against Dexie on the same origin.

## Sub-features

- `collections-put` solitary-puts N user rows (primary + index keys in one OCC transaction).
- `collections-get-id` gets each user by id.
- `collections-where-email` equality-looks up each email before ingest.
- `collections-ingest` publishes to OPFS.
- `collections-where-post-ingest` repeats email where after ingest.
- `collections-dexie-compare` times Dexie puts/gets/where for comparison.

## How to get to it (user POV)

- Run `pnpm bench:collections` from the monorepo root (or the helper drive).
- Or open the served `packages/collections/bench/browser.html?auto=1&n=50` and read `#out`.

## Driving it with verify-opfs-lsm

Preconditions:

- `verify-opfs-lsm doctor` prints `doctor: ok` including `collections dist: present`.
- `packages/collections/.bench-chrome-profile` does not exist.

- **Run the bench.** Execute `.agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm drive collections-bench`. Exit code `0`.
- **Confirm SharedWorker.** Stdout contains `mode=SharedWorker + BrowserFs (OPFS)`.
- **Confirm collections path.** Stdout contains timed lines including `collections solitary put`, `collections get by id`, and `collections where email` (and post-ingest where when the harness prints it).
- **Proof.** Keep `artifacts/collections-bench/<run-id>/stdout.txt` with exit `0` and the SharedWorker mode line.

## Gotchas

- Fixed profile under `packages/collections/.bench-chrome-profile` — one collections bench per checkout at a time.
- Collections solitary put is heavier than Dexie row put (index keys in the same transaction); do not treat a slower put row as a functional failure.
- Build both `@opfs-lsm/kv` and `@opfs-lsm/collections` before driving; the helper `launch` does both.
