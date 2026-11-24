# Bounded compaction memory (issue #101)

Status: shipped in #128, which derives the whole budget from `compactionMemoryBytes`. design.md
describes it under "Memory budget", "Merging", "L0 stop" and "Backpressure". R3, R4, R9, R10 and
the items under "Not built" are open.

Date: 2026-11-09 to 2026-11-20. Headless Chrome 156 and 157.0.8103.39, macOS arm64, machine shared.
The wasm figures were measured on the Rust engine, which the AssemblyScript engine replaced on
2026-11-22, and nobody has measured them again.

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
twice the 160 MB estimate above.

## What shipped, and what was rejected

#128 shipped a merge session that the host pumps, with one source per L0 run and one for the
overlapped next level, and output that streams to disk. design.md owns the design. Only the
session's reader returns `OUT_OF_MEMORY` when a reservation misses. Running out of memory in its
writer traps (`packages/kv/engine/abi.md`, "Memory").

Rejected, with the reasons:

- **Key-range sliced steps with a stateless merge** (the second candidate).
  Its bound is slice size times a fudge factor, needing a 32 MiB floor and a
  64 MiB default, and verifying a ranged read needs an SST format change. The
  concatenated-level source removes the reason to slice at all.
- **An SST v2 per-block CRC.** A running CRC with one `combine` per run checks
  the same bytes without a format change. Per-block CRC is universal in prior
  art, but no engine holds a compaction until a whole-file checksum matches.
  The difference is only when corruption is caught. Revisit if tabs ever read
  runs in ranges they have not checked.
- **A fixed ceiling with halve-and-retry on trap.** A trap drops wasm for the
  whole context. A failed reserve fails cleanly.
- **A source cap of 16.** A stop at S settles near S/2 L0 runs per step, and a
  random-key step rewrites all of L1, so a low stop doubled compaction writes.
  The sweep chose S = 49.

Tradeoffs accepted:

- A resumable state machine, the most complex part of the engine, in exchange for memory that does
  not depend on step size.
- A corrupt input caught only when its last block is used, possibly after its outputs exist on
  disk, with installation still gated on every CRC.
- Uncapped step bytes, with the L0 stop capping the damage.
- Grow-then-recycle instead of a hard slab.
- More, smaller L0 runs when ingest lags, each an extra merge source, absorbed by the L0 stop.

## Memory budget arithmetic

A flush and a merge session run on one wasm instance and can overlap, so
`hostBudget(B)` splits B between the module and both:

```
B = W0 + 10F + S(2C + K)
```

- B is `compactionMemoryBytes`, T is the output run target (4 MiB), and W0 is
  the module's memory when idle (1.06 MiB on a fresh instance).
- F is the flush run size in op bytes. A flush costs at most 10F: roughly 5.4F in
  wasm and 3F in JS (the WAL records, the folded entries and the copy of the
  result).
- S is the number of sources a step reads, C is the window it holds per
  source, and K is the per-source block buffers and slots. A source holds C
  in wasm, and up to C more is in flight in JS between a read and
  `merge_feed`. K is about 16 KiB (12 to 21 KiB measured).

The measurements below use 16-byte keys and 100-byte values, so an op is 116
bytes and a packed entry is 133. Each is the wasm memory of a fresh instance of
the Rust engine, module included. `pnpm --filter @opfs-lsm/kv probe:wasm-memory`
reruns them on the current engine.

| flush alone, F (MiB) | 0.875 | 1.0 | 1.75 | 2.0 | 3.5 | 4.0 |
|---|---:|---:|---:|---:|---:|---:|
| wasm after repeated flushes (MiB) | 5.3 | 8.6 | 9.4 | 16.1 | 17.8 | 30.8 |

Wasm memory grows in steps at power-of-two input sizes, and the packed input
is 1.15F. An F at 7/8 of a power of two stays just under a step: 1.75 MiB
costs 9.4 MiB and 2 MiB costs 16.1. That is why `F = 7/8 · min(T, B/16)`.

Smaller ops cost more wasm memory per op byte, because the encoder keeps a
few dozen bytes per entry. A flush chunk counts an op as at least 32 bytes,
so a chunk holds at most F/32 ops. With that floor, a 1.75 MiB chunk of
distinct keys peaks at 10.5 MiB with 20-byte ops, 17.2 with 32-byte ops,
18.1 with 40-byte ops and 16.0 with 64-byte ops. A chunk that rewrites 100
keys peaks at 7.0 MiB or less at every op size, since every write is copied
into wasm before the losers are dropped.

| merge alone, S = 49 | C = 64 KiB | C = 128 KiB | C = 256 KiB |
|---|---:|---:|---:|
| wasm peak (MiB) | 5.3 | 8.2 | 14.5 |

A tail longer than the window makes every source's window grow to it: 64 KiB
windows with a 128 KiB tail peak at 11.3 MiB, so `tailBytes` never exceeds
`chunkBytes`.

| flush and merge overlapped | S | C | F | wasm peak (MiB) |
|---|---:|---:|---:|---:|
| B = 16 MiB | 44 | 64 KiB | 0.875 MiB | 9.6 |
| B = 32 MiB | 49 | 128 KiB | 1.75 MiB | 16.3 |
| B = 64 MiB | 49 | 256 KiB | 3.5 MiB | 31.2 |
| the 256 KiB window at B = 32 MiB | 49 | 256 KiB | 1.75 MiB | 22.8 |

Add the JS side, `S·C` of reads in flight and about 3F of flush, and the
overlap totals 15.0, 27.7 and 53.9 MiB at 16, 32 and 64 MiB: 94%, 87% and
84% of B. The 256 KiB window at 32 MiB would total 40.3 MiB, 1.3 times B.
The JS terms are estimates, not measurements.

The recycle threshold, B/2, is 16 MiB at 32 MiB: above the 9.4 MiB a flush needs alone and the
8.2 MiB a merge needs alone, just below the 16.3 MiB of an overlap. It fires after an overlap and
not after every flush.

An entry larger than 64 KiB adds about twice its size to the window of the
source that holds it. The overshoot is documented, not enforced.

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
hook installed before kv instantiates.

## Results with the budgets in use, Chrome 157.0.8103.39

The last step of #128 against the commit it builds on, which had the same flush run, L0 stop
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
17.6 s instead of 9.9. That is the price of an 8.8 MiB wasm peak instead of
19.2. The halved windows cost the final compaction, not the writes: `settle`
is 0.1 to 0.5 s longer and the L0 stop fires a few times per run.

`kv/fillrandom` and `kv/overwrite` at size small showed no write phase
measurably slower at 32 MiB.

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

## Not built

Checked against the code on 2026-11-24.

- **Flush splits at L1 run boundaries plus L0 sublevels**, as Pebble does with
  `FlushSplitBytes` and L0 sublevels (R4): L0-to-L1 steps scoped to one key
  interval, each step bounded. With random keys every flush spans the whole
  key range, so it only pays once the planner groups non-overlapping L0 files
  into one source. Try this before the next item.
- **Commit progress inside a running step**, following SlateDB's incremental
  compaction (RFC-0035): the finished key prefix is installed through trimmed
  views of the input runs (R3).
- **Fewer short-lived ArrayBuffers in the SharedWorker.** The workload
  allocates about 1.3 GiB of them in 9 s and V8 frees them on its own
  schedule, keeping the unforced SharedWorker peak near 100 MiB at any B while
  the live set stays under B. Candidates not tried: reuse the read buffers of
  a compaction step, and stop making an object per op when a flush folds the
  WAL records. Gate: `--max-peak-bytes` at 1.25x B passing at 32 and 16 MiB.

Open: Firefox and Safari are probed for neither `createWritable` buffering nor
instance-drop-to-GC. If a browser keeps pending writes in memory, add T per
open output to that browser's budget.

## Prior art

A survey on 2026-11-09 read RocksDB, LevelDB, Pebble, Badger, TigerBeetle, fjall, SlateDB and
mini-lsm at the tags under "Sources", and checked the design against them. Its recommendations,
and where each stands:

| # | Recommendation | Prior art | Today |
|---|---|---|---|
| R1 | Stop ingest at `l0StopRuns` ≤ `maxSources − 1` L0 runs | Every engine ends backpressure at an L0 count: LevelDB 12 files, Pebble 12 sublevels, Badger 15, RocksDB 36 | Shipped, design.md "L0 stop" |
| R2 | Move run size from the path into the manifest and stream output blocks into one `createWritable` | RocksDB, LevelDB and Pebble write blocks as they are built and keep the size in the manifest. Badger and mini-lsm build the table first | Shipped, manifest-format.md and design.md "Merging" |
| R3 | Call the phase-2 idea "incremental commit with trimmed run views" | SlateDB RFC-0035 commits a running compaction's durable key prefix through narrowed views. Pebble's virtual sstables serve ingest and excise only | Not built |
| R4 | Before R3, try flush splits at L1 run boundaries | Pebble `FlushSplitBytes` with L0 sublevels. RocksDB also compacts L0 into L0 when Lbase is more than 20x L0 | Not built |
| R5 | Stream the CRC state over data, call `combine` once for the tail | RocksDB `FileChecksumGenerator::Update` | Shipped, in the merge session's input reader |
| R6 | Block and LZ4 decoders stay in bounds on any bytes, since entries are decoded before their run's CRC is known | Not needed elsewhere: RocksDB and Pebble never decode unverified bytes | Shipped, verification.md "Fuzz the decoders" |
| R7 | Budget the output's bloom hashes, 4 B per key, as their own term | RocksDB charges them as `kFilterConstruction`. Badger, mini-lsm and Pebble keep a u32 per key | Not a term. The merge figures above include the writer, at 133-byte entries |
| R8 | Request ingest at 7/8 of `memtableBytes`, wait at 1x | RocksDB WriteBufferManager flushes at 7/8 and stalls at 1x. Pebble stops at 2x memtable | Shipped, design.md "Backpressure" |
| R9 | Cut outputs of L1 and deeper at grandparent overlap | LevelDB and Pebble, 10 × target | Not built |
| R10 | Give `WebAssembly.Memory` a `maximum` from B | The JS API accepts `maximum`. `memory.grow` returns −1 on failure | Not built |

The survey confirmed these choices without a change:

- **One source per L0 run plus one concatenated source per level.** RocksDB and LevelDB build
  exactly this iterator. Pebble uses one source per L0 sublevel, and TigerBeetle merges one table
  with the concatenation of the next level's. RocksDB caps neither the L0 files of an L0→Lbase
  step nor its bytes, and runs one L0 compaction at a time.
- **A 256 KiB read window and a 128 KiB tail.** Pebble's local read-ahead is 256 KiB, and RocksDB
  found 256 KB best for its whole-file checksum scan. RocksDB's compaction default of 2 MB is for
  spinning disks. Pebble reads 32 KiB for the footer and 512 KiB for index and filter.
- **Emit before the CRC, install after DONE.** RocksDB cleans up the outputs of an aborted
  compaction and installs all subcompaction outputs in one edit.
- **Stop between keys.** LevelDB flushes a waiting memtable from inside its compaction loop.
  RocksDB checks for abort every 1000 keys. TigerBeetle splits compaction into beats.
- **One merge at a time.** LevelDB runs one background compaction. TigerBeetle's compaction CPU
  pool has size 1.
- **A whole-file CRC instead of per-block CRCs.** Every engine checks each block before decoding
  it. Whole-file checksums (RocksDB, fjall) are computed while writing and checked only by
  explicit scans. LevelDB compacts without checking block CRCs by default, and Badger defaults
  to `NoVerification`. The whole-file CRC makes every input's bloom a compaction read, where
  RocksDB skips filters. That cost is not measured.
- **Instance recycling has no precedent.** Wasm has no instruction that shrinks memory.
  `memory.discard` is a Phase 1 proposal.

Facts a later decision could use:

- Output targets: RocksDB 64 MB, LevelDB 2 MiB, Pebble 2 MB at L0 doubling per level, Badger
  2 MiB. LevelDB and Pebble bound a step's growth at 25 × target.
- The File System spec says a writable stream is "typically implemented by writing data to a
  temporary file" but models it as an in-memory `[[buffer]]`. Only Chrome is probed (above).
- `Blob.stream()` supports BYOB reads, so reads could fill reused JS buffers, not wasm memory,
  whose `ArrayBuffer` cannot be detached. Browser support is not verified.

The survey ran no code. It did not cover WiredTiger, ScyllaDB, Cassandra, AgateDB or sled, and
found no browser or wasm LSM engine to compare against.

## Sources

Each was cloned or downloaded on 2026-11-09 at the pin shown.

- RocksDB `v11.13.2`: https://github.com/facebook/rocksdb/tree/v11.13.2
- Pebble `v2.1.7`: https://github.com/cockroachdb/pebble/tree/v2.1.7
- LevelDB `1.23`: https://github.com/google/leveldb/tree/1.23
- TigerBeetle `0.17.10`: https://github.com/tigerbeetle/tigerbeetle/tree/0.17.10
- Badger `v4.9.6`: https://github.com/dgraph-io/badger/tree/v4.9.6
- fjall-rs/lsm-tree `3.1.10`: https://github.com/fjall-rs/lsm-tree/tree/3.1.10
- SlateDB `v0.18.1`, RFC-0035: https://github.com/slatedb/slatedb/blob/v0.18.1/rfcs/0035-incremental-compaction.md
- mini-lsm `df2120d7`: https://github.com/skyzh/mini-lsm/tree/df2120d7252ca2180a00a051ab307893a51545ab
- WebAssembly spec `f3268fa9`: https://github.com/WebAssembly/spec/tree/f3268fa9dcb7d3a60d09546e743e7281e75cddb0
- WebAssembly memory-control `62fac131`: https://github.com/WebAssembly/memory-control/tree/62fac131de7e6406c9c05b493457025c2e42a15c/proposals/memory-control
- WHATWG File System `d76d3455`: https://github.com/whatwg/fs/blob/d76d3455d5afe2f85754ed24ffdbf99fe30032d4/index.bs
- W3C File API `2f610830`: https://github.com/w3c/FileAPI/blob/2f610830afbbcb8116c3f3fc22062c0980456291/index.bs
