# Bounded compaction memory (issue #101)

Design for keeping SharedWorker and tab memory under app-set budgets. It
was produced with `/architect`: two independent candidates, then a merge of
the two. It was then checked against prior art in
`lsm-compaction-memory-prior-art.md`; the R-numbers below refer to its
recommendations. Nothing here is implemented yet.

## Problem

Today, one compaction step holds about 4× its input bytes, and nothing caps
how many input bytes a step has.

- `mergeNextStep` (`host/compact.ts`) reads every input run whole.
- `FlatEngine.mergeSsts` copies all of them into wasm memory.
- `merge_sst_bytes` (`engine-core/src/compact.rs`) decodes every input into
  a `Vec<Entry>`, which costs two heap allocations per entry. It builds
  every output run before it returns.
- The result is copied out again.

With random keys, every L0→L1 step spans all of L1, which is about 40 MB. That
puts the step's peak near 160 MB. Wasm memory (talc) never shrinks, so the
SharedWorker keeps that peak for as long as it lives. The merge is also one
synchronous call, so it blocks the SharedWorker's event loop for the whole
step. While it runs, ingest requests wait, the WAL grows, tab memtables grow,
and the next `ingestAll` folds the whole backlog into one large L0 run. The
engine.ts comment cites a 73 MB flush that needed about 200 MiB. So
compaction and ingest feed each other's memory growth.

Constraints from grounding:

- Compaction runs in a SharedWorker, which has async OPFS only. Sync access
  handles exist only in dedicated workers.
- A wasm call cannot await I/O, so any streaming merge has to be driven from
  JS.
- The browser APIs used today are enough: ranged reads with `File.slice` and
  `createWritable` with several `write` calls before `close`. Rename (`move`)
  is not used.
- The SST v1 CRC covers the whole file.
- The bloom filter is sized from the entry count.
- No backward compatibility is needed (AGENTS.md), so the manifest format may
  change. The SST format stays.
- The rules to keep:
  - The newest run wins, and within one run the last duplicate wins.
  - Tombstones are dropped only on a `bottom` step, and `droppedSeq` records
    the highest one dropped.
  - Outputs split at key boundaries.
  - A crash leaves only unreferenced files.
  - A corrupt input is never installed.

## Usage (caller's view)

```ts
const db = await openDb({
  name: "todos",
  memoryBudget: 64 << 20,          // existing: tab run-file cache
  memtableBytes: 32 << 20,         // new: rows not yet in OPFS; ingest is requested at 7/8, write() waits at 1×
  compactionMemoryBytes: 32 << 20, // new: SharedWorker working set for one merge + one flush
});
```

When tabs pass different values, the SharedWorker uses the smallest, the same
rule as `maxWalBytes`. A key or value larger than 64 KiB can push past the
budget by a small multiple of its size. This is documented, not enforced.

Internal driver (`host/compact.ts`):

```ts
const merge = openMerge({ sources, dropTombstones: plan.bottom, targetBytes: T, codec, chunkBytes });
try {
  for (;;) {
    const s = merge.pump();
    if (s.kind === "need") await answer(s.demands);          // parallel ranged reads → merge.feed()
    else if (s.kind === "write") await out.write(s.bytes);   // opens c<top+1>.<i> on the run's first write
    else if (s.kind === "run-end") outputs.push(await out.finish(s.run)); // { path, bytes, range }
    else if (s.kind === "yield") await yieldToEventLoop();
    else return finish(s.droppedSeq);
  }
} finally { merge.close(); }
```

## Shape

### 1. Run size moves into the manifest (`store/generation.ts`, `store/levels.ts`)

`RunMeta` gains `bytes: number`, which is encoded in the manifest next to the
key range. Run paths no longer carry a size: `levelRunPath(level, name)` gives
`l<n>/<name>.sst`. These read `r.bytes` instead of parsing the path:

- `levels.ts`: `sizeOf` and `bytesOf`;
- `counting-fs.ts`;
- the host's layout stats.

L0 runs get a size too, so the merge knows every input's size without opening
the file first. This is what RocksDB's `FileDescriptor` and LevelDB's
`FileMetaData` do. It is the change that lets output stream to disk (R2).

`runMeta(path, body)`, which today parses the body for the key range, is
replaced by what the writer reports at the end of a run: its size, its first
key and its last key.

### 2. Merge sources, not runs (planner, `store/levels.ts`)

`CompactionPlan.inputs: RunMeta[]` becomes `sources: RunMeta[][]`, newest
first, and `inputs` is derived from it.

- **One source per L0 run, one for the next level.** Each L0 run is its own
  source. The overlapped part of the next level is **one concatenated
  source**, read run after run. This is RocksDB's `LevelIterator`, LevelDB's
  concatenating `TwoLevelIterator` and TigerBeetle's "concatenation of tables
  B".
- **The result.** An Ln step always has 2 sources, and an L0 step has (number
  of L0 runs taken) + 1. This is the decision that takes step size out of the
  memory formula.
- **The cap.** The planner caps sources only. An L0 step takes the *oldest*
  `maxSources − 1` L0 runs. Newer L0 runs stay in front, which is correct
  because they are newer than everything in the step. With the L0 stop in
  section 5, the cap rarely applies.

### 3. Resumable merge session in wasm (`engine-core/src/merge.rs`, replaces `compact.rs`)

ABI (`crates/engine-abi.md`). These four calls replace `merge_ssts`:

```text
merge_open(ptr,len, drop_tombstones, target_bytes: f64, lz4, chunk_bytes, yield_bytes) -> i32
    input: u32 source_count · (u32 run_count · u32 run_size*)*   newest source first; sizes from RunMeta.bytes
    reserves the whole working set with try_reserve; 0 | -11 OUT_OF_MEMORY | -13 SESSION_OPEN
merge_pump() -> i32
    1 NEED     result: (u32 source · u32 run · u32 offset · u32 len)*  — demand 0 blocks progress, rest is read-ahead
    2 WRITE    result: the next bytes of the current output run, in file order (≤ chunk_bytes)
    3 RUN_END  result: u32 size · u32 key_len · first key · u32 key_len · last key
    4 YIELD    yield_bytes of input consumed since last stop
    5 DONE     result: u64 dropped_seq; every input run's CRC matched
    <0         corruption codes, -14 OUT_OF_ORDER, -16 UNFED
merge_feed(source, len) -> u32   address to write exactly the demanded bytes; 0 if len mismatches
merge_close() -> i32             frees the working set; idempotent, safe after errors
```

The rules the engine follows:

- **The engine owns the offsets.** It holds each run's block table and asks
  for whole blocks only. JS keeps one `OpenFile` per run and does no offset
  arithmetic, so the data bytes reach the engine strictly in file order.
- **Reading a run.** A run's first demand is its tail, the last
  `min(size, 128 KiB)`. This is the same tail guess `sst-reader.ts` uses. If
  the bloom filter starts further back, a second demand reads from
  `bloom_offset` up to the tail. The engine parses the block table from the
  tail and then drops the tail. The 256 KiB read-ahead per source matches
  Pebble's.
- **CRC check on a run read in pieces** (R5).
  1. The data bytes go through the streaming CRC state that `crc32.rs`
     already has.
  2. `crc_tail` is computed over the bloom, index and footer fields when the
     tail is read.
  3. When the run's last block is used, the engine checks
     `combine(crc_data, crc_tail, tail_len) == stored`. This is one
     `combine` per run.
  4. Entries from a run are emitted before its CRC is known. That is safe
     because outputs are installed only after DONE. A failed step deletes the
     outputs it wrote. RocksDB cleans up aborted outputs the same way.
- **Decoding stays in bounds on corrupt bytes** (R6). Blocks are decoded
  before their run's CRC is checked, unlike RocksDB and Pebble, which check
  each block first. So the block and LZ4 decoders must return an error on any
  input and never trap or read out of bounds. The session property test
  includes corrupted inputs, and the fuzz targets cover the block decoder by
  itself.
- **Pump stops only between keys.** `cur`/`look` slots per source carry the
  "last duplicate wins" rule across block, chunk and run boundaries. The slots
  are reused buffers, so the merge loop allocates nothing per entry, where
  today it allocates two heap Vecs per entry. Stopping only between keys
  matches LevelDB, which flushes a pending memtable from inside its compaction
  loop between keys.
- **Ownership.** One session per module. JS copies each WRITE out before it
  awaits and never holds a view into wasm memory across an await. That makes
  recycling and concurrent flush calls safe.

### 4. Streaming `SstWriter` (`engine-core/src/sst.rs`)

`SstWriter` produces a run in file order and hands bytes out as they are
ready, the way RocksDB, LevelDB and Pebble write each block to the file as it
is built.

- **While a run is open:**
  - it emits each finished data block;
  - it keeps one u32 hash per key, because every bloom probe derives from
    `fnv1a(key)` (Badger, mini-lsm and Pebble do the same);
  - it keeps the index entries;
  - it keeps a running CRC over every byte it has emitted.
- **At `finish`:** it emits the bloom filter, the index and the footer, and
  reports the run's size and its first and last keys.
- **Memory:** about one block plus `4 B × keys` plus the index. That is no
  longer `T`.

`encode_sst` drives it and becomes the only encoder. Concatenating everything
it emits must give **byte-identical** output to today's encoder, so the SST
format does not change. It refuses keys that arrive out of order. The flush
(`publishL0`) streams through the same writer.

### 5. Host policy (`host/budget.ts`, `host/engine-host.ts`, `host/ingest.ts`)

- **One formula.** `hostBudget(B) → { chunkBytes, tailBytes, maxSources,
  flushRunBytes, l0StopRuns, yieldBytes, wasmRecycleBytes }`. This is the only
  place the formula lives, and tests pin its outputs (see the arithmetic
  below).
- **One merge at a time** per SharedWorker, across all of its databases,
  through a host-wide `mergeSlot` mutex (`inMergeSlot` in
  `host/merge-slot.ts`). LevelDB runs one background compaction, and
  TigerBeetle's compaction pool has size 1. A second wasm session is a host
  bug and throws, so the old fallback to the TypeScript session is gone: the
  second merge waits instead. A flush does not take the slot.
- **Bounded flush.**
  - `ingestAll` folds the oldest uningested records, at most `flushRunBytes`
    of op bytes per L0 run and always at least one record.
  - Each chunk is published and acknowledged as it is today, and the loop
    repeats up to `through`.
  - It takes the ingest lock per chunk, so `installStep` can run in between.
  - `IdBWal.listUningested({ maxBytes })` stops past the cap.
- **L0 stop** (R1).
  - **The rule.** While L0 holds `l0StopRuns` runs (`= maxSources − 1`), a
    fold waits for the running compaction to install before it publishes
    another L0 run.
  - **Precedent.** Every engine surveyed stops writes when L0 piles up:
    LevelDB at 12 files, Pebble at 12 sublevels, Badger at 15, RocksDB at 36.
  - **Pressure goes back to the tab.** The WAL grows, the memtable reaches its
    cap, and writes wait. A deep step that runs for a long time therefore
    can't grow L0 without limit.
- **Yield.** Every NEED already awaits real OPFS reads. On top of that, YIELD
  fires every 1 MiB of input, so the event loop is never held for more than
  about a millisecond and ingest is served during a 400 MB step. This fixes
  the coupling between compaction and ingest.
- **Wasm memory.** There is no fixed slab. The working set is reserved at
  `merge_open`: a miss returns -11 and never traps. Talc still never shrinks
  memory, so when no session is open and `memory.buffer.byteLength >
  wasmRecycleBytes`, the host **recycles the instance** from the cached
  `WebAssembly.Module`. For that to work, `useLz4Decoder` and
  `useBlockScanner` must read the current engine instead of capturing `mod`.
  No other project was found that recycles instances, and whether it gives
  memory back is unverified (see the open questions).
- **TS fallback** (`store/merge-ts.ts`). It implements the same
  `MergeCore` pump/feed interface and writes raw output. It buffers up to T
  of entries and then encodes, so it is bounded at about B + 8 MiB. This is
  documented, not enforced.

### 6. Tab memtable backpressure (`db.ts`, `store/memtable.ts`)

`Memtable.bytes` = Σ(key + value + overhead) over live rows. There are two
thresholds, the same split RocksDB's WriteBufferManager uses between
`mutable_limit_` and its stall (R8).

- **At 7/8 of `memtableBytes`,** the tab requests one coalesced ingest with
  `settle = false` and does not wait. That request already exists in
  `EngineHost.ingest`, and it does not wait for compaction.
- **At 1×,** `write` waits before `appendAfter` for that ingest to return, then
  loads the new generation. An ingest held back by the L0 stop just returns
  later.
- **If the ingest returns and the generation has not advanced,** the write
  goes through anyway, so a broken host can't deadlock writes.

### Memory budget arithmetic

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
If it keeps them in memory, add up to T per open output, which is the
probe in step 1.

An entry larger than 64 KiB adds about twice its size to the window of the
source that holds it.

On the tab side, `memtable ≤ memtableBytes + one batch`, on top of the
existing `memoryBudget`.

### Measurement (bench/)

- **Chrome.** `bench/driver/chrome.ts` auto-attaches to `shared_worker`
  targets over CDP and polls `Runtime.getHeapUsage` every 100 ms on the
  SharedWorker and on each tab. It records the peak `usedSize`, plus
  `backingStorageSize` where Chrome reports it.
- **Every browser.** `HostStats.memory` reports `wasmBytes`,
  `wasmPeakBytes`, `mergeReservedBytes`, `recycles` and `l0Stops`.
- **Workload.** A new `kv/compaction-memory` workload runs the todo example
  for 20 rounds × 100k and asserts peak ≤ 1.25·B.
- **Throughput.** Compare `kv/fillrandom --size large` and `kv/overwrite`
  against main.

## Synthesis decision

Two candidates were sketched independently:

- **A** (opus): a streaming merge session in wasm.
- **B** (sonnet): "bound the work, not the merge". The planner cuts each step
  into key-range slices of about 8 MiB. Each slice goes through a stateless
  `merge_slice`, the outputs are staged and installed all at once, and SST v2
  adds a per-block CRC so a ranged read can be verified.

**A is the base.** Three reasons:

- Its peak does not depend on step size, and its constants are smaller. B
  needs a 64 MiB default and has a 32 MiB floor driven by `4.5·D + 6.75·T`.
- It keeps the SST format.
- The concatenated-level source removes the reason to slice at all. RocksDB,
  LevelDB, Pebble and TigerBeetle all merge this way.

B's main objection to A is that the ABI is stateful and could leak state when
it traps. The design answers it with `merge_close`, which is idempotent, with
the rule that JS never holds a wasm view across an await, and with instance
recycling.

Taken from B:

- **The slice-invariance property test**, reworked as a session test. Random
  chunk sizes and random read-ahead answers must produce the same output as a
  reference fold. This is the main correctness proof.
- **Keeping the flush inside the same budget** instead of giving it its own
  knob. B's `MemoryGate` becomes A's `mergeSlot`, plus a flush term in the
  formula.
- **Progress inside a running step** as a phase-2 answer. See "Later".

Rejected from B:

- **The SST v2 format change.** A's running CRC with `combine` checks the same
  bytes without changing the format. Prior art checks a CRC per block, but no
  engine holds a compaction back until a whole-file checksum matches, so the
  difference only changes *when* corruption is caught. Revisit if tabs ever
  read runs in ranges they haven't checked.
- **The fixed ceiling plus halve-and-retry on a trap.** A trap drops wasm for
  the whole context, while reserving at `merge_open` fails cleanly with -11.

Changed after the prior-art review:

- **Byte size moves into the manifest**, so output streams to disk (R2).
- **An L0 stop** (R1).
- **Two memtable thresholds** (R8).
- **The hash buffer is its own budget term** (R7).
- **The data CRC is computed while streaming**, with `combine` once per run
  (R5).
- **The decoders must never trap on corrupt bytes** (R6).
- **Phase 2 cites SlateDB, not Pebble** (R3).

## Tradeoffs accepted

- We accept a resumable state machine in Rust, which becomes the most complex
  part of the engine, in exchange for memory that does not depend on step
  size and a merge loop that allocates nothing per entry.
- We accept that a corrupt input is caught only when its last block is used,
  possibly after its outputs exist on disk, in exchange for never holding a
  whole run. Installation is still gated on every CRC. Decoders have to be
  safe on garbage as a result.
- We accept two merge cores, Rust and TS, behind one driver, as the SST codec
  has today, in exchange for a bounded fallback.
- We accept an uncapped step byte size. The L0 stop caps the damage: writes
  slow down instead of L0 growing without limit.
- We accept letting wasm memory grow and then recycling the instance, instead
  of a hard slab, in exchange for never trapping when the budget is missed.
- We accept a manifest format change (run size in `RunMeta`) in exchange for
  streaming output and sizes for L0 runs.
- We accept more, smaller L0 runs when ingest lags, in exchange for a bounded
  flush. Each one adds a merge source, and the L0 stop absorbs that.

## Alternatives considered

- **Slice steps by key range with a stateless merge.** This is candidate B.
  Its memory bound comes from slice size times a fudge factor and needs a
  32 MiB floor. Verifying a ranged read needs an SST format change or a second
  read pass. A gets a lower bound without either.
- **Merge loop in TS, wasm called per block.** The heap, the duplicate rules,
  block cutting and the bloom filter would live in TS, with a wasm call and a
  copy per 4 KiB block in each direction. The SST format would then be spread
  across both languages.
- **Cap step bytes in the planner and keep whole-run reads.** This is the
  smallest change. But the bound becomes 4 × the cap, and with random keys
  every L0 run overlaps every L1 run, so splitting the step multiplies write
  amplification.
- **Keep the size in the path and buffer each output run.** This costs about
  3·T. It was the plan before the prior-art review.
- **Compact in a nested dedicated worker with sync access handles.** It is
  not verified that a SharedWorker can start a dedicated worker in Safari and
  Firefox. It is also not needed: async ranged reads are enough.

## Later (not in #101)

- **Flush splits at L1 run boundaries plus L0 sublevels**, as Pebble does with
  `FlushSplitBytes` and L0 sublevels (R4).
  - **What it gives:** L0→L1 steps scoped to one key interval, so each step
    is bounded.
  - **Why it isn't cheap:** with random keys every flush spans the whole key
    range, so it only pays once the planner groups L0 files that don't
    overlap into one source. Try this before the next item.
- **Commit progress inside a running step**, following SlateDB's incremental
  compaction (RFC-0035).
  - **How:** the finished key prefix is installed through trimmed views of
    the input runs.
  - **Precedent:** SlateDB, not Pebble. Pebble's virtual sstables serve ingest
    and excise, not a compaction still in progress (R3).
- **Cut outputs where they overlap the grandparent level**, about 10×T as in
  LevelDB and Pebble, for L1 and deeper (R9).
- **A `maximum` on `WebAssembly.Memory`**, derived from B. `memory.grow` then
  fails at the budget, so a miss is always a clean -11 (R10).

## Open questions and risks

- **Defaults.** Is 32 MiB right as the `compactionMemoryBytes` default, and
  32 MiB as the `memtableBytes` default? With streaming output, the minimum
  can drop to about 16 MiB.
- **Throughput margin.** Do we accept 10% or 20%? The estimate is neutral or
  faster: no per-entry allocation and no whole-buffer copies, against one
  ranged read per 256 KiB per source.
- **Pending `createWritable` data.** Do Chrome, Firefox and Safari keep pending
  writes on disk or in memory? The spec models them as an in-memory buffer. If
  any browser keeps them in memory, add T to `P_host` for that browser. Probe
  this in step 1.
- **Instance recycling.** Does dropping a `WebAssembly.Instance` give its
  memory back in Chrome, Safari and Firefox? `memory.discard` is only a
  Phase 1 proposal. Probe this in step 1.
- **Chrome's heap counters.** Does `Runtime.getHeapUsage` report
  `backingStorageSize` in the Chrome the bench uses? Without it, wasm and
  ArrayBuffer bytes come only from the engine's own counters.
- **Large values.** For values over 64 KiB, do we document the overshoot or
  add `maxValueBytes`?
- **Risk: resumability bugs** at block, chunk, run and duplicate boundaries.
  The mitigations are the session property test, including corrupted inputs,
  the existing fuzz corpus, and a counting-allocator test that the pump does
  not allocate once warm.

## Probe results, Chrome 156.0.8078.80

Chrome only, macOS arm64, headless. Firefox and Safari are not probed. Rerun
with `node bench/probes/memory.ts [writable|wasm-drop]`. Process memory is
`phys_footprint` from `footprint(1)`, which counts compressed pages.

**Pending `createWritable` data stays off the heap and goes to disk.** A
SharedWorker wrote 200 MiB to one OPFS file in 4 MiB chunks without calling
`close()`.

| written | browser process | largest renderer | profile dir on disk |
|---:|---:|---:|---:|
| 0 | 72 MiB | 60 MiB | 3 MiB |
| 50 MiB | 70 MiB | 60 MiB | 55 MiB |
| 100 MiB | 75 MiB | 60 MiB | 104 MiB |
| 150 MiB | 81 MiB | 60 MiB | 152 MiB |
| 200 MiB | 82 MiB | 60 MiB | 200 MiB |

The browser process grew by about 10 MiB, which is not 200. The profile
directory grew one-to-one with the writes before `close()`. The SharedWorker
heap stayed at 0 MiB used and 4 MiB backing. So no `T` term per open output
is needed for Chrome. The probe does not show what a crash before `close()` leaves on disk.

**Dropping a `WebAssembly.Instance` gives its memory back after a forced GC.**
The probe instantiates `engine.wasm`, grows its memory to 300 MiB, touches
every 4 KiB page, then drops the instance and calls
`HeapProfiler.collectGarbage`. The same probe runs in a SharedWorker and in a
tab.

| step | SharedWorker's renderer | tab's renderer |
|---|---:|---:|
| grown to 300 MiB | 335 MiB | 331 MiB |
| dropped, 0.5 s, no GC | 335 MiB | 331 MiB |
| after `collectGarbage` | 35 MiB | 31 MiB |
| 3 s and GC again | 35 MiB | 31 MiB |

The process kept running and the SharedWorker kept answering messages, so the
drop was not a process exit. Dropping alone returned nothing within 0.5 s.
Whether Chrome collects an unreferenced instance on its own, and how soon, is
not measured here. Recycling can rely on the memory coming back only once a GC
runs; the page cannot force one.

**`Runtime.getHeapUsage` reports `backingStorageSize`, but it does not count
wasm memory.** During the 300 MiB probe the SharedWorker reported
`backingStorageSize` of 4 MiB. In the `kv/compaction-memory` run it reported
about 190 MiB, which is ArrayBuffer memory,
while the wasm memory was 340 MiB. The bench therefore adds the wasm size from
`memory.buffer.byteLength`, found by a hook that the bench installs before kv
instantiates (`WASM_HOOK` in `bench/driver/memory.ts`). Chrome's own counters
cannot give the wasm size.

### Baseline on main

`kv/compaction-memory`, size small: 20 rounds of 100k random puts into a 400k
key pool (keys 16 B, values 100 B), then settle, then 20k checked reads.
Median of 5 runs, with the min to max range. The heap and wasm peaks are
sampled every 100 ms. The largest renderer is the kernel's own peak
(`phys_footprint_peak`). The machine was shared (load 7 to 14 on 18 cores), so
read the ranges.

| measure | median (range) |
|---|---:|
| SharedWorker JS heap used | 51 MB (44 to 54) |
| SharedWorker ArrayBuffer backing | 214 MB (180 to 242) |
| SharedWorker wasm memory | 306 MB (302 to 332) |
| Tab JS heap used | 70 MB (56 to 75) |
| Tab wasm memory | 1.2 MB |
| Largest renderer process | 714 MB (705 to 740) |
| `rounds` phase wall time | 7.8 s (6.8 to 7.8) |

Compaction wrote 565 MB (541 to 689) for 232 MB of user bytes, and 44 MB
stayed on disk. The SharedWorker's wasm memory alone is about twice the 160 MB
estimate in the problem statement. This PR does not break down why. Later PRs
compare against these numbers.

The harness reads the renderer processes once a second. It first read them
every 100 ms, and that slowed the engine it was measuring: in the same session
that version took 9.1 s (6.9 to 10.5) for the rounds and saw 335 MB (310 to
350) of wasm memory.

## Implementation order

Each step can ship as its own PR:

1. **Measure and probe.**
   - Add heap sampling of the SharedWorker and tabs, plus the
     `kv/compaction-memory` workload, to bench/. This gives the baseline the
     acceptance criteria need.
   - Probe each browser: does it keep pending `createWritable` data in memory,
     and does dropping a wasm instance give its memory back?
2. **Bounded flush, L0 stop and memtable backpressure.** These are TS only and
   need no engine change. They remove the ingest feedback loop by themselves.
3. **Run size in the manifest, and the streaming `SstWriter`.**
   - `RunMeta.bytes`, paths without sizes, and `levels.ts`, `counting-fs.ts`
     and the stats moved over to the manifest size.
   - Concatenating the writer's output must be byte-identical to `encode_sst`
     over the fuzz corpus.
   - The flush streams through the writer.
4. **Merge session.** The planner's `sources`, the `merge_*` ABI, the driver
   loop, the TS `MergeCore`, and decoders that are safe on garbage. Then
   delete `merge_ssts` and `compact.rs`.
5. **Budgets in use.** `hostBudget`, the `openDb` options, the `mergeSlot`,
   and instance recycling, then run `verify-kv` and the bench against the
   acceptance criteria.

The full candidate sketches, with type signatures and pseudocode for every
module, are in `bounded-compaction-memory/candidate-a.md` (the base, and the
contract for step 4) and `bounded-compaction-memory/candidate-b.md`. Where
they disagree with this file (the output path, the budget formula, the L0
cap), this file wins.
