# Bench baseline

Reference for the Dexie comparison that `pnpm bench:gate` checks. The gate remeasures on each run. This file records one host on 2026-11-03.

## Rules

`pnpm bench:gate` fails when any of these is true.

- `kv one batch` is slower than `dexie bulkPut`.
- Browser `kv point get (warm)` is slower than `dexie point get`.
- `kv solitary put` is over 2 times `dexie solitary put`.
- The kv JS gzip size is greater than or equal to the Dexie JS gzip size. The wasm file is separate and is not part of that comparison.
- A required row is missing, the browser log is not `OPFS=true` and `mode=SharedWorker`, or `kv point get (post-ingest)` has no finite time.

Equal times pass. Node `kv point get` must be printed. It does not have to beat Dexie.

Node uses `BENCH_N=500`. The browser leg uses `BENCH_N=50` and the SharedWorker. `BENCH_LOCAL=1` opens the in-page engine and is not the gate path. Set `BENCH_GATE_NODE_N` or `BENCH_GATE_BROWSER_N` to change the counts.

## Host

The machine was an Apple M5 Max with 18 cores, on darwin. Node was v24.15.0. Chrome was 156.0.8078.80. Load average at the start was 2.37, 2.47, 2.35.

## Node fake-indexeddb

The command was `pnpm bench` with N=500. Five runs, each measuring kv, raw IndexedDB, and Dexie in that order. The median is the middle run. Times are milliseconds for the whole loop.

| row | median ms | range ms |
| --- | --- | --- |
| kv solitary put | 22.1 | 22.0 to 22.6 |
| kv one batch | 0.8 | 0.7 to 0.8 |
| kv point get | 34.7 | 33.8 to 34.9 |
| idb solitary put | 16.7 | 16.1 to 16.8 |
| idb one transaction | 7.8 | 7.5 to 8.3 |
| dexie solitary put | 27.6 | 27.2 to 28.5 |
| dexie bulkPut | 7.8 | 7.8 to 8.3 |
| dexie point get | 7.1 | 7.1 to 7.5 |

Batch stays under Dexie by more than the 0.1 ms range. Solitary put stays under 2 times Dexie. Point get is slower than Dexie on every run. The gap is about 27 ms, and the range on each side is about 1 ms, so the loss is not noise.

A separate run at N=5000, not included in the table, spent its samples in fake-indexeddb `_findRecords` under an IndexedDB cursor. A counter on the get loop showed 2 `openCursor` calls and 1 `get` for the whole loop at N=50, 200, 500, and 1000. The first get replays the WAL through `IdBWal.listRange` and `headSeq`. The rest hit the in-memory overlay. That one cursor walk is most of the 34.7 ms. Dexie point get is a point lookup, 7.1 ms median at N=500 and 128.1 ms at N=5000. The N=5000 kv get loop was 2955.2 ms, so the cursor walk gets slower faster than N.

The batch row was not profiled on its own. It is 0.8 ms. Doubling it would still leave it under the 7.8 ms Dexie `bulkPut`.

## Browser SharedWorker

The command was `BENCH_N=50 pnpm bench:browser`. The page checked that each warm get, each post-ingest get, and each Dexie get returned the stored bytes. Five runs.

| row | median ms | range ms |
| --- | --- | --- |
| kv solitary put | 8.9 | 6.9 to 10.2 |
| kv one batch | 0.4 | 0.2 to 0.4 |
| kv point get (warm) | 1.5 | 1.3 to 2.6 |
| kv ingest to OPFS | 13.7 | 11.8 to 16.7 |
| kv point get (post-ingest) | 2.1 | 1.9 to 3.6 |
| dexie solitary put | 9.4 | 7.9 to 9.5 |
| dexie bulkPut | 1.1 | 1.0 to 1.2 |
| dexie point get | 3.2 | 3.0 to 3.2 |

The second run was batch 0.4 ms versus Dexie `bulkPut` 1.1 ms, warm get 1.3 ms versus Dexie point get 3.2 ms, and solitary put 6.9 ms versus Dexie 7.9 ms.

Two later `pnpm bench:gate` runs also passed. One printed a batch of 0.5 ms and a Dexie point get of 3.5 ms. Both figures sit outside the five-run range. Both runs still passed the rules.

Batch stays under Dexie on every run, and the gap is larger than the range. Warm get stays under Dexie on every run. The slowest warm get was 2.6 ms and the fastest Dexie get was 3.0 ms. The warm-get range is 1.3 ms, which is wider than that 0.4 ms gap, so the size of the lead is not stable. Solitary put overlaps Dexie. There is no measurable winner. The slowest solitary put was 10.2 ms, under the 2x line near 19 ms.

A separate N=2000 run, not part of the table, took 271.1 ms for kv solitary put and 269.5 ms for Dexie. Those match, so a solitary put is bound by one IndexedDB commit per key. The same run took 14.1 ms for warm get and 114.5 ms for Dexie point get. A `sample` of the Chrome browser process during that run sat in the AppKit event loop. It did not sample the renderer, so there is no renderer stack for the warm get.

`BENCH_LOCAL=1` with N=50 printed `mode=local EngineHost + BrowserFs (OPFS)` and `OPFS=true`, and the post-ingest get row was present. That run is not a gate run.

## Bundle

The command was `pnpm exec tsx scripts/measure-bundle.ts` from `packages/kv`, after `tsc`. One run.

| artifact | raw bytes | gzip bytes |
| --- | --- | --- |
| Dexie JS | 100327 | 32839 |
| kv JS | 34517 | 11478 |
| kv wasm | 54255 | not in the JS gzip |

The kv JS gzip is under the Dexie JS gzip. The wasm bytes stay out of that comparison.

## Prior single run

These numbers are the single run from earlier on 2026-11-03, before Dexie point get existed on Node. They are not the five-run medians above.

Node fake-indexeddb, N=500. kv solitary put 21.4 ms, idb solitary put 16.1 ms, Dexie solitary put 27.9 ms. kv one batch 0.7 ms, Dexie `bulkPut` 8.0 ms. kv point get 33.5 ms.

Browser SharedWorker, N=50. kv solitary put 9.6 ms, Dexie solitary put 9.2 ms. kv one batch 0.4 ms, Dexie `bulkPut` 1.2 ms. kv warm get 1.4 ms, post-ingest get 2.1 ms, Dexie point get 3.1 ms. Ingest 14.1 ms.

Bundle from that run. Dexie JS raw 100294, gzip 32822. kv JS raw 34464, gzip 11461. kv wasm raw 54255.
