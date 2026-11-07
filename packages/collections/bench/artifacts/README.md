# Collections where email — profile notes

These notes record an older profile. `openViewSnapshot`, `layersStale`, and `KeyOverlay` are gone. `Table.where` reads with `db.rangeFollow`.

Claim: `where("email", …)` for 50 equality lookups on SharedWorker Chrome.

Machine: darwin, load ~1.4 on 18 cores, one-run ballpark then 5-run medians.

## Baseline (before fixes)

Median of 5, `BENCH_N=50`:

- collections where email: 21.9 ms (range 19.6–23.7)
- collections where post-ingest: 65.7 ms (range 65.3–67.8)
- dexie where email: 3.4 ms (range 3.2–3.9)

Profile (`BENCH_PROFILE=1`), one run:

- pre-ingest: viewOpen 16.6 ms, range 1.9 ms, get 0.2 ms
- post-ingest: viewOpen 48.8 ms, range 2.5 ms, get 0.3 ms

Limiter: `openViewSnapshot` forced `layersStale` on every `range`/`view`, so each lookup paid IDB head/ingested and (post-ingest) OPFS generation metadata.

## After fixes

Median of 5, `BENCH_N=50` (see `final-5runs.txt`):

- collections where email: 1.1 ms (range 1.0–1.2)
- collections where post-ingest: 0.6 ms (range 0.5–0.9)
- dexie where email: 4.1 ms (range 3.6–5.6)

Primary number for the PR: where email **21.9 ms → 1.1 ms** (median of 5).

Fixes, in order:

1. Stop forcing `layersStale` in `openViewSnapshot` (don't revalidate IDB/OPFS when layers are warm).
2. Cache sorted merged puts on the Db; pin views with `puts.slice()`.
3. Binary-search range on the pinned put list; cache `KeyOverlay.entriesSorted`.
4. `scanIndex` uses one `db.view` for index range + primary gets.
