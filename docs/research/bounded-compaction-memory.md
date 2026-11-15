# Bounded compaction memory (issue #101)

Status: shipped in #128, which derives the whole budget from
`compactionMemoryBytes`. The behavior as it runs is design.md's "Compaction",
including "Memory budget" and "L0 stop". This note keeps what design.md must not
carry: the problem, the arithmetic behind the budget table, the platform
probes, and the before/after results. The R-numbers are the recommendations of
`lsm-compaction-memory-prior-art.md`, which checked the design against
production LSM engines at pinned tags.

## Problem

Compaction memory was unbounded. One step held about 4x its input bytes, and
nothing capped how many input bytes a step had: the merge read every input run
whole, copied all of it into wasm memory, decoded every input into a `Vec` of
entries (two heap allocations per entry), and built every output run before
returning. With random keys, every L0-to-L1 step spans all of L1, about 40 MB,
which put the step's peak near 160 MB. Wasm memory never shrinks, so the
SharedWorker kept that peak for as long as it lived. The merge was also one
synchronous call, so it blocked the SharedWorker's event loop: ingest requests
waited, the WAL grew, tab memtables grew, and the next ingest folded the whole
backlog into one large L0 run. Compaction and ingest fed each other's memory
growth.

Baseline on main, `kv/compaction-memory` size small (20 rounds of 100k random
puts into a 400k key pool, then settle, then 20k checked reads; median of 5,
Chrome 156, machine shared, load 7-14 on 18 cores):

| measure | median (range) |
|---|---:|
| SharedWorker JS heap used | 51 MB (44 to 54) |
| SharedWorker ArrayBuffer backing | 214 MB (180 to 242) |
| SharedWorker wasm memory | 306 MB (302 to 332) |
| Tab JS heap used | 70 MB (56 to 75) |
| Largest renderer process | 714 MB (705 to 740) |
| `rounds` wall time | 7.8 s (6.8 to 7.8) |

Compaction wrote 565 MB for 232 MB of user bytes. The wasm memory alone is about
twice the 160 MB estimate above. Reading the renderer processes every 100 ms
instead of once a second slowed the engine it measured (9.1 s rounds, 335 MB
wasm), which is why bench reads them once a second.

## Decision

- **A streaming merge session in wasm, pumped by the host.** The session owns
  every offset and asks for whole blocks: NEED reads the listed byte ranges of
  the inputs and feeds them in, WRITE writes output bytes, RUN_END finishes a
  file, YIELD gives the event loop a turn every 1 MiB of input, DONE installs.
  The host reads with `File.slice` and writes with `createWritable`; the
  browser APIs already suffice. The session checks each input run's CRC before
  its last entries are used, and entries are emitted before that: safe because
  outputs are installed only after DONE, and a failed step deletes what it
  wrote. Because blocks are decoded before their run's CRC is known, the block
  and LZ4 decoders must return an error on any input and never trap or read out
  of bounds (R5, R6). The session property test covers corrupted inputs, and
  the fuzz targets cover the block decoder alone.
- **One source per L0 run; the overlapped runs of the next level are one
  concatenated source.** An Ln step always has 2 sources; an L0 step has one
  per L0 run taken plus one. Step memory no longer depends on step size.
  RocksDB, LevelDB, Pebble and TigerBeetle all merge this way.
- **A source cap plus an L0 stop** (R1). An L0 step takes the oldest
  `maxSources - 1` L0 runs; newer runs stay in front, which is correct because
  they are newer than everything in the step. At `l0StopRuns` L0 runs a fold
  waits for the running compaction to install, the same relief valve every
  engine surveyed has (LevelDB 12 files, Pebble 12 sublevels, Badger 15,
  RocksDB 36). Pressure goes back to the tab instead of L0 growing without
  limit.
- **A bounded flush.** `flushRunBytes` of op bytes per L0 run, always at least
  one record, published and acked chunk by chunk. The tab requests ingest at
  7/8 of `memtableBytes` and waits at 1x, the split RocksDB's
  WriteBufferManager uses (R8).
- **One merge at a time per SharedWorker**, across its databases, through a
  host-wide slot; a flush does not take the slot. LevelDB runs one background
  compaction, and TigerBeetle's compaction pool has size 1.
- **The working set is reserved at merge_open.** A miss returns -11 and never
  traps; there is no fixed slab. Since wasm memory never shrinks, the host
  recycles the instance when no session is open and memory passes
  `wasmRecycleBytes` = B/2. Chrome gives a dropped instance's memory back only
  after a GC, which the page cannot force (probe below). No other project was
  found that recycles instances.
- **Output streams to disk, and the run size moved into the manifest** (R2),
  so the writer reports size and first/last keys and L0 runs know their size
  without being opened. Output runs cut at about 4 MiB of records, the normal
  target in LevelDB, Badger and Pebble L0. Concatenated writer output is
  byte-identical to the old encoder over the fuzz corpus, so the SST format
  did not change.

Rejected, with the reasons:

- **Key-range sliced steps with a stateless merge** (the second candidate).
  Its bound is slice size times a fudge factor, needing a 32 MiB floor and a
  64 MiB default, and verifying a ranged read needs an SST format change. The
  concatenated-level source removes the reason to slice at all.
- **An SST v2 per-block CRC.** A running CRC with one `combine` per run checks
  the same bytes without a format change. Per-block CRC is universal in prior
  art, but no engine holds a compaction until a whole-file checksum matches;
  the difference is only when corruption is caught. Revisit if tabs ever read
  runs in ranges they have not checked.
- **A fixed ceiling with halve-and-retry on trap.** A trap drops wasm for the
  whole context; a failed reserve fails cleanly with -11.

The design merged two independently written candidates; their sketches are
deleted from the repo and live only in git history. This file and the prior-art
verdict table are the merged record.

Tradeoffs accepted: a resumable state machine in Rust, the most complex part of
the engine, in exchange for memory that does not depend on step size; a corrupt
input caught only when its last block is used, possibly after its outputs exist
on disk, with installation still gated on every CRC; two merge cores, Rust and
TS, behind one driver; uncapped step bytes with the L0 stop capping the damage;
grow-then-recycle instead of a hard slab; more, smaller L0 runs when ingest
lags, each an extra merge source, absorbed by the L0 stop.

## Memory budget arithmetic

A flush and a merge session run on one wasm instance and can overlap, so
`hostBudget(B)` splits B between the module and both:

```
B = W0 + 10F + S(2C + K)
```

- B is `compactionMemoryBytes`, T is the output run target (4 MiB), and W0 is
  the module's memory when idle (1.06 MiB on a fresh instance).
- F is the flush run size in op bytes. A flush costs about 10F: roughly 7F in
  wasm and 3F in JS (the WAL records, the folded entries and the copy of the
  result).
- S is the number of sources a step reads, C is the window it holds per
  source, and K is the per-source block buffers and slots. A source holds C
  in wasm, and up to C more is in flight in JS between a read and
  `merge_feed`. K is about 16 KiB (12 to 21 KiB measured).

The measurements below use 16-byte keys and 100-byte values, so an op is 116
bytes and a packed entry is 133. Each is the wasm memory of a fresh instance,
module included. `pnpm --filter @opfs-lsm/kv probe:wasm-memory` reproduces
them.

| flush alone, F (MiB) | 0.875 | 1.0 | 1.75 | 2.0 | 3.5 | 4.0 |
|---|---:|---:|---:|---:|---:|---:|
| wasm after repeated flushes (MiB) | 6.5 | 10.1 | 11.9 | 19.3 | 22.8 | 36.9 |

Wasm memory grows in steps at power-of-two input sizes, and the packed input
is 1.15F. An F at 7/8 of a power of two stays just under a step: 1.75 MiB
costs 11.9 MiB and 2 MiB costs 19.3. That is why `F = 7/8 · min(T, B/16)`.

| merge alone, S = 49 | C = 64 KiB | C = 128 KiB | C = 256 KiB |
|---|---:|---:|---:|
| wasm peak (MiB) | 5.3 | 8.2 | 14.5 |

A tail longer than the window makes every source's window grow to it: 64 KiB
windows with a 128 KiB tail peak at 11.3 MiB, so `tailBytes` never exceeds
`chunkBytes`.

| flush and merge overlapped | S | C | F | wasm peak (MiB) |
|---|---:|---:|---:|---:|
| B = 16 MiB | 44 | 64 KiB | 0.875 MiB | 9.8 |
| B = 32 MiB | 49 | 128 KiB | 1.75 MiB | 18.8 |
| B = 64 MiB | 49 | 256 KiB | 3.5 MiB | 36.1 |
| the 256 KiB window at B = 32 MiB | 49 | 256 KiB | 1.75 MiB | 25.1 |

Add the JS side, `S·C` of reads in flight and about 3F of flush, and the
overlap totals 15.2, 30.2 and 58.8 MiB at 16, 32 and 64 MiB: 95%, 94% and
92% of B. The 256 KiB window at 32 MiB would total 42.6 MiB, 1.3 times B.
The JS terms are estimates, not measurements.

The first draft capped S at 16 and counted a flush as 3F. The flush costs
more than that, and the cap was too low: the sweep behind the bounded flush
found that a stop at S settles near S/2 L0 runs per step, and that a
random-key step rewrites all of L1, so a low stop doubled compaction writes.
The sweep chose S = 49. Budgeting that many sources at the default needs a
128 KiB window.

Past 64 MiB nothing grows but the recycle threshold, B/2. At 32 MiB it is 16
MiB: above the 11.9 MiB a flush needs alone and the 8.2 MiB a merge needs
alone, below the 18.8 MiB of an overlap. It fires after an overlap and not
after every flush.

All of this assumes the browser keeps pending `createWritable` writes on disk.
If it keeps them in memory, add up to T per open output, which is the probe
below.

An entry larger than 64 KiB adds about twice its size to the window of the
source that holds it. The overshoot is documented, not enforced.

On the tab side, `memtable <= memtableBytes + one batch`, on top of the
existing `memoryBudget`.

## Probe results, Chrome 156.0.8078.80

Chrome only, macOS arm64, headless. Firefox and Safari are not probed. Rerun
with `node bench/probes/memory.ts [writable|wasm-drop]`. Process memory is
`phys_footprint` from `footprint(1)`, which counts compressed pages.

**Pending `createWritable` data stays off the heap and goes to disk.** A
SharedWorker wrote 200 MiB to one OPFS file in 4 MiB chunks without calling
`close()`:

| written | browser process | largest renderer | profile dir on disk |
|---:|---:|---:|---:|
| 0 | 72 MiB | 60 MiB | 3 MiB |
| 100 MiB | 75 MiB | 60 MiB | 104 MiB |
| 200 MiB | 82 MiB | 60 MiB | 200 MiB |

The profile directory grew one-to-one with the writes before `close()` and the
SharedWorker heap stayed flat, so no T term per open output is needed for
Chrome. The probe does not show what a crash before `close()` leaves on disk.

**Dropping a `WebAssembly.Instance` gives its memory back after a forced GC.**
The probe grows `engine.wasm` to 300 MiB, touches every page, drops the
instance and calls `HeapProfiler.collectGarbage`, in a SharedWorker and in a
tab:

| step | SharedWorker's renderer | tab's renderer |
|---|---:|---:|
| grown to 300 MiB | 335 MiB | 331 MiB |
| dropped, 0.5 s, no GC | 335 MiB | 331 MiB |
| after `collectGarbage` | 35 MiB | 31 MiB |

Dropping alone returned nothing within 0.5 s. Whether Chrome collects an
unreferenced instance on its own, and how soon, is not measured. Recycling
relies on the memory coming back only once a GC runs.

**`Runtime.getHeapUsage` reports `backingStorageSize`, but it does not count
wasm memory.** It reported about 190 MiB of ArrayBuffer while wasm held
340 MiB, so the bench adds wasm size from `memory.buffer.byteLength` via a
hook installed before kv instantiates. Chrome's own counters cannot give the
wasm size.

## Results with the budgets in use, Chrome 157.0.8103.39

Step 5 against the commit it builds on, which had the same flush run, L0 stop
and source cap as B = 32 MiB but fixed 256 KiB windows, no merge slot and no
recycling. macOS arm64, headless, machine shared (load 5 to 18).
Interleaved runs, 11 per column. Each cell is the median with the min-max
range in brackets, MiB unless a unit is given.

| measure | B = 32 MiB | B = 16 MiB | before |
|---|---:|---:|---:|
| SharedWorker wasm memory, peak | 15.2 (14.9 to 16.9) | 8.8 (8.8 to 9.3) | 19.2 (17.4 to 20.9) |
| recycles | 0 (0 to 1) | 7 (3 to 9) | none |
| `rounds` (s) | 8.70 (7.69 to 15.41) | 17.57 (11.86 to 24.99) | 9.93 (7.02 to 11.78) |
| `settle` (s) | 1.30 (0.66 to 1.99) | 1.98 (1.21 to 3.43) | 0.84 (0.47 to 2.02) |
| L0 flushes | 157 (151 to 161) | 296 (294 to 299) | 155 (147 to 161) |
| compaction steps | 12 (11 to 12) | 18 (18 to 19) | 13 (13 to 13) |
| compaction written | 325 (285 to 332) | 547 (538 to 582) | 352 (348 to 362) |
| L0 stops | 4 (3 to 4) | 11 (11 to 12) | 0 |

The wasm memory is what the budget controls, and it is exact: it is not
garbage-collected, and `HostStats.memory` counts it. It peaks 21% below the
fixed-window version at 32 MiB and 54% below at 16 MiB. At 32 MiB, `rounds`
is level with the fixed-window version (paired runs split 5 to 6) and the
host recycles almost never. At 16 MiB the same writes make 296 L0 runs
instead of 155, compaction writes 547 MiB instead of 352, and `rounds` takes
17.6 s instead of 9.9: that is the price of an 8.8 MiB wasm peak instead of
19.2. The halved windows cost the final compaction, not the writes: `settle`
is 0.1 to 0.5 s longer and the L0 stop fires a few times per run.

`kv/fillrandom` and `kv/overwrite` at size small touched the new code lightly
and showed no write phase measurably slower at 32 MiB; only `settle` was
slower, as above. `--size large` crashed headless Chrome before its first
phase for every contender, including the IndexedDB baseline.

### The peak check counts garbage, and it fails on the old code too

`--max-peak-bytes` at 1.25x B failed all 15 sampled runs, on both budgets and
on the fixed-window version. The peak sums three samples of the SharedWorker,
each at its own time (JS heap used 29-37 MiB, ArrayBuffer backing 43-65 MiB,
wasm 8.8-19.2 MiB), and most of that sum is garbage.

Heap snapshots every 0.5 s (`node bench/probes/live-set.ts`), V8 collecting
before it writes one:

| alive in the SharedWorker | B = 32 MiB | B = 16 MiB | before |
|---|---:|---:|---:|
| JS side, median (max) | 5.8 (9.2) | 2.1 (4.9) | 6.2 (9.4) |
| wasm memory, median (max) | 14.9 (16.9) | 7.8 (8.8) | 17.2 (18.9) |
| JS + wasm, largest snapshot | 26.0 | 13.6 | 26.8 |

The live set stays under B at both budgets: 0.81x B at 32 MiB and 0.85x B at
16 MiB, under the arithmetic's 30.2 and 15.2. The ~80 MiB above it is
allocation churn, not what the host holds: the workload moves about 1.3 GiB
of ArrayBuffers in the 9 s of `rounds`, and the backing peaks near V8's 64 MiB
external-memory threshold for starting a collection. A smaller B cannot move
this part, which is why B = 16 MiB shows the same garbage. Reading
`getHeapUsage` right after two forced collections read two to three times
higher than the snapshots and is not a substitute.

## Later (not in #101)

- **Flush splits at L1 run boundaries plus L0 sublevels**, as Pebble does with
  `FlushSplitBytes` and L0 sublevels (R4): L0-to-L1 steps scoped to one key
  interval, each step bounded. With random keys every flush spans the whole
  key range, so it only pays once the planner groups non-overlapping L0 files
  into one source. Try this before the next item.
- **Commit progress inside a running step**, following SlateDB's incremental
  compaction (RFC-0035): the finished key prefix is installed through trimmed
  views of the input runs. The precedent is SlateDB, not Pebble; Pebble's
  virtual sstables serve ingest and excise, not a compaction still in progress
  (R3).
- **Cut outputs where they overlap the grandparent level**, about 10x T as in
  LevelDB and Pebble, for L1 and deeper (R9).
- **A `maximum` on `WebAssembly.Memory`** derived from B, so `memory.grow`
  fails at the budget and a miss is always a clean -11 (R10).
- **Fewer short-lived ArrayBuffers in the SharedWorker.** The workload
  allocates about 1.3 GiB of them in 9 s and V8 frees them on its own
  schedule, keeping the unforced SharedWorker peak near 100 MiB at any B while
  the live set stays under B. Candidates not tried: reuse the read buffers of
  a compaction step, and stop making a view per key and per value when a
  flush folds the WAL records. Gate: `--max-peak-bytes` at 1.25x B passing at
  32 and 16 MiB.

## Open questions and risks

- **Firefox and Safari** are probed for neither `createWritable` buffering nor
  instance-drop-to-GC. If a browser keeps pending writes in memory, add T per
  open output to that browser's budget.
- **Defaults.** 32 MiB holds: the live set peaks at 0.81x B and writes keep
  their speed. 16 MiB works at about twice the rounds time, 8 MiB is the
  floor.
- **Risk: resumability bugs** at block, chunk, run and duplicate boundaries.
  Mitigations: the session property test including corrupted inputs, the
  fuzz corpus, and a counting-allocator test that the pump does not allocate
  once warm.
