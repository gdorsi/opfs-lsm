# Candidate A: a resumable merge session in wasm (issue #101)

Direction: the merge's state lives in Rust/wasm. JS opens a session with N
sources, answers the engine's ranged-read demands, and drains finished output
runs. Peak memory is about one read-ahead chunk per source plus one output run,
independent of step size. On-disk SST v1 is unchanged.

---

## Problem

A compaction step today holds every input and every output at once, about 4x
the step's input bytes: `mergeNextStep` reads each input whole, `FlatEngine.mergeSsts`
copies them into one wasm buffer, `merge_sst_bytes` decodes every input into
`Vec<Entry>` (two heap allocations per entry) and encodes every output before
it returns, and JS slices the packed result out. Step size is unbounded:
random keys make every L0→L1 step span all of L1 (40 MB, so about 160 MB
peak), and an Ln run's overlap with Ln+1 has no cap. The talc allocator never
shrinks wasm memory, so the SharedWorker keeps its largest step's footprint
for good. The merge is one synchronous call, so a large step blocks the
SharedWorker's event loop, ingest waits, and the WAL and every tab's memtable
grow. Ingest folds all lagging WAL records into one unbounded L0 run.

Constraints that shape the design (from Phase A):

- Wasm calls are synchronous and the SharedWorker has only async OPFS, so any
  streaming merge is driven from JS. No nested dedicated worker.
- Output paths carry the byte size (`l<n>/<name>-<bytes>.sst`) and `FileSystemHandle.move`
  is off the table, so an output run is fully encoded before its file is created.
- SST v1 puts data blocks first and a whole-file CRC in the footer. Streaming
  has to keep "a corrupt input is never installed".
- Newest-run-wins, last duplicate within a run wins, tombstones dropped only
  on `bottom`, `droppedSeq`, outputs split at key boundaries, crash mid-step
  leaves only unreferenced files.
- The TS fallback must stay correct; bounded is preferred.
- Assumed (Phase C must confirm): default budget 32 MiB for the SharedWorker,
  throughput regression margin 10 to 20%, memtable backpressure in scope.

## Usage (caller's view)

### App: one `openDb` call

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({
  name: "todos",
  memoryBudget: 64 << 20,          // existing: this tab's run-file cache
  memtableBytes: 16 << 20,         // new: this tab's unflushed rows; writes wait for ingest past it
  compactionMemoryBytes: 32 << 20, // new: the SharedWorker's working set for one merge + one flush
});

await db.put(key, value); // returns as today; waits only while the memtable is over memtableBytes
```

README text:

> **Memory.** `memtableBytes` (default 32 MiB, min 1 MiB) bounds the rows a tab
> holds that are not yet in OPFS. Past it, a write waits until the SharedWorker
> has flushed them. `compactionMemoryBytes` (default 32 MiB, min 24 MiB) bounds
> what the SharedWorker uses to flush and compact: one merge at a time per
> SharedWorker, whatever the database size. When several tabs pass different
> values, the SharedWorker uses the smallest. Entries larger than 64 KiB can
> push past the budget by a small multiple of the entry size. Without wasm,
> the fallback is bounded too but needs about 8 MiB more than the budget.

### Internal call site 1: the compaction driver (`host/compact.ts`)

```ts
const merge = openMerge({
  sources: plan.sources.map((runs) => runs.map((r) => r.size)), // newest source first
  dropTombstones: plan.bottom,
  targetBytes: TARGET_RUN_BYTES,
  codec: codecForLevel(plan.outputLevel),
  chunkBytes: budget.chunkBytes,
});
try {
  for (;;) {
    const s = merge.pump();
    if (s.kind === "need") await answer(s.demands);          // parallel ranged OPFS reads, then merge.feed(...)
    else if (s.kind === "output") await writeOutput(s.sst);  // s.sst is a JS copy; at most one write in flight
    else if (s.kind === "yield") await yieldToEventLoop();
    else return finishStep(s.droppedSeq);
  }
} finally {
  merge.close();
}
```

### Internal call site 2: the host and the bench

```ts
const stats = await ingestClient.stats("todos");
stats.memory; // { wasmBytes, wasmPeakBytes, mergeReservedBytes, recycles }
```

## Shape

### Data structures first

**Source**, not run, is the merge's unit of input. A source is a newest-first
slot holding an ordered list of runs that do not overlap: one L0 run is a
source, and the overlapped slice of a level (L1 for an L0 step, Ln+1 for an Ln
step) is one *concatenated* source, read run after run like RocksDB's
LevelIterator. This is the decision that makes memory independent of step
size: an L0→L1 step over 40 MB of L1 has 1 + (L0 runs taken) sources, not
14 inputs, and an Ln step always has exactly 2.

```
CompactionPlan.sources: RunMeta[][]   newest source first; inputs = sources.flat() (derived)
```

**MergeSession** (Rust, `engine-core/src/merge.rs`) owns all merge state:

```
MergeSession
├─ sources: Vec<Source>          newest first; index = recency rank
├─ heap: Heads(Vec<u16>)         source indices, ordered by (source.cur.key, index)
├─ pending: Vec<u16>             sources whose winner was consumed and must advance before the next pick
├─ demands: Vec<Demand>          reads issued and not yet fed
├─ writer: SstWriter             the output run being built; reserved at T + slack
├─ tail: Vec<u8>                 scratch for one run's bloom+index+footer while its block table is parsed
└─ dropped, drop_tombstones, target, yield_bytes, consumed_since_yield

Source
├─ runs: Vec<u32>                run sizes; run i's path stays in JS (index pairs with the demand)
├─ run: usize                    current run
├─ blocks: Vec<u32>              current run's block lengths (offsets are cumulative; contiguity checked)
├─ next_block: usize             next block to pull out of `chunk`
├─ chunk: Vec<u8> (cap C)        fed bytes: whole blocks only, file offset `chunk_at`
├─ block: Vec<u8>                current block, raw or LZ4-unpacked (≈ 4 KiB)
├─ cursor                        record walk inside `block`
├─ cur, look: Slot               `cur` = this source's resolved entry for its smallest key (last duplicate wins);
│                                 `look` = first entry of the next key. Slot = {key: Vec<u8>, value: Vec<u8>, tag, seq}, reused
├─ crc_data: u32, data_fed: u32  running CRC over data bytes fed in file order
└─ crc_tail: u32, tail_len, stored_crc   from the tail, checked when the run's last block is consumed
```

`Slot` buffers are owned and swapped, never reallocated per entry: decoding
copies a key suffix and value into a reused buffer (one memcpy), replacing
today's two heap allocations per entry. The heap holds `u16`s.

**SstWriter** (`engine-core/src/sst.rs`) is incremental and becomes the only
encoder: `encode_sst(&[Entry])` sorts refs and drives it. It lays the run out
in one buffer in file order: data blocks, then (at `finish`) bloom, index,
footer. So no second full copy exists. It keeps one `u32` FNV hash per key
(4 B/key) because the bloom is sized by key count and every probe derives from
`h1 = fnv1a(key)` (`bloom.rs`), then builds the bloom at `finish`. The block
cut uses the existing `split_blocks` running-sum rule, buffering only the
current block's records, so output bytes are identical to today's encoder.
It refuses a key smaller than the previous one (`OUT_OF_ORDER`): a corrupt
input that reorders keys cannot produce a malformed output.

### The ABI (`crates/engine-abi.md`)

```text
merge_open(ptr, len, drop_tombstones: i32, target_bytes: f64, lz4: i32,
           chunk_bytes: u32, yield_bytes: u32) -> i32
    Input: source list = u32 source_count · repeated (u32 run_count · repeated u32 run_size),
    newest source first. Reserves the whole working set (per-source chunk and
    block buffers, the writer at target + 64 KiB, the tail scratch) with
    try_reserve. 0, or -11 OUT_OF_MEMORY, or -13 SESSION_OPEN. One session per module.

merge_pump() -> i32
    Runs until it must stop. Non-negative states:
      1 NEED    result: demand list = u32 count · repeated (u32 source · u32 run · u32 offset · u32 len).
                Demand 0 blocks progress; the rest are read-ahead for sources below half a chunk.
                JS answers every demand before the next pump (else -16 UNFED).
      2 OUTPUT  result: one finished SST, valid until the next merge_* call.
      3 YIELD   `yield_bytes` of input consumed since the last stop; no result.
      4 DONE    result: u64 dropped_seq. Every input run's CRC has matched.
    Negative: the usual corruption codes (CRC_MISMATCH when a run's last block
    is consumed), -14 OUT_OF_ORDER, -11 when a scratch buffer cannot grow.

merge_feed(source: u32, len: u32) -> u32
    Address where JS writes exactly `len` bytes answering that source's
    outstanding demand; 0 when `len` is not what was demanded. Counted on the
    next pump.

merge_close() -> i32
    Frees the working set. Idempotent; safe after an error.
```

`merge_ssts` is removed. `merge_sst_bytes` stays only as a `#[cfg(test)]`
oracle-free helper that drives a session over whole buffers, so there is one
merge implementation.

**Who tracks the next block.** The engine. It has every run's block table, it
knows which sources hold the heap's next keys, and it issues demands as
`(source, run, offset, len)` covering whole blocks only, up to `chunk_bytes`
(at least one block, so an oversized single-record block grows the chunk via
try_reserve). JS keeps one `OpenFile` per (source, run) and does no
arithmetic. A run's first demand is its tail: `[size − min(size, 128 KiB), size)`,
then `[bloom_offset, tail_start)` if the bloom reaches further back (same
`TAIL_GUESS` as `sst-reader.ts`).

**CRC of a file consumed piecemeal.** The v1 CRC covers `data | bloom | index |
footer fields`. On the tail, the engine computes `crc_tail = crc32(tail[bloom_offset..crc_off])`,
parses block lengths (checking they are contiguous from offset 0 to
`bloom_offset`), and drops the tail. Data arrives strictly in file order
because the engine issues the demands, so `crc_data = combine(crc_data,
crc32(chunk), chunk.len())` per feed (`crc32.rs` already has zlib's `combine`;
it becomes `pub`). When a run's last block is consumed:
`combine(crc_data, crc_tail, tail_len) == stored_crc` or the session fails
with -4. Entries from a run are emitted before its CRC is known, which is safe
because outputs are installed only after DONE, and DONE requires every run to
have matched. A failed step removes the outputs it wrote (see driver). The
guarantee "a corrupt input is never installed" holds; "no byte of a corrupt
input is ever parsed" does not, and the parser is already hardened for that
(fuzzed bounds checks, `lz4_unpack` ratio cap).

### Pump: resumable without partial steps

The session stops only at points with no half-done key:

```
pump():
  require demands.is_empty()               // all answered (else -16)
  absorb fed bytes into each source's chunk; update crc_data
  loop:
    // 1. finish advances left over from the last stop
    for s in pending: match sources[s].try_advance():
        Ready(entry) => heap.push(s)
        Exhausted    => {}                 // CRC checked inside try_advance at run end
        NeedBytes    => collect demand(s); keep s pending
    if demands non-empty: add read-ahead demands for sources below C/2; return NEED
    if writer has a finished run: return OUTPUT   (writer is reset on the next pump)
    if consumed_since_yield >= yield_bytes: return YIELD
    let Some(top) = heap.top() else { if writer.has_data(): finish → OUTPUT; else DONE }
    // 2. one key: every source holding it leaves the heap; the lowest index wins
    k = sources[top].cur.key
    winner = top; pop every source whose cur.key == k into `pending`
    if !(drop_tombstones && winner.cur is Del): writer.add(winner.cur)
    else dropped = max(dropped, winner.cur.seq)
    if writer.data_len() >= target: writer.finish()   // split at a key boundary
```

`try_advance` moves `look` into `cur`, then decodes into `look` until the key
changes, swapping buffers on an equal key, which is how "the last duplicate in
a run wins" survives block and chunk boundaries. Moving to the next run of a
concatenated source first checks the finished run's CRC, then demands the next
tail. Because emission happens before any source advances and the heap only
holds ready sources, every stop leaves a consistent state. The rules are the
same as `merge_sst_bytes`: newest source wins, shadowed sources skip the key,
tombstones go only on `bottom`.

### TS driver (one per host, `host/compact.ts`)

```
mergeNextStep(fs, base, knownTop, budget):
  plan = planCompaction(base.runs, { maxSources: budget.maxSources })
  files = open every input run (OpenFile, size from the handle)        // L0 paths carry no size
  merge = openMerge({...})                                              // wasm, or the TS core
  written = []; inflight = undefined
  try:
    loop on merge.pump():
      need   → await Promise.all(demands.map(d => files[d.source][d.run].read(d.offset, d.len)))
               then merge.feed(d.source, bytes) for each, in demand order
      output → await inflight; path = levelRunPath(level, `c${top+1}.${i++}`, sst.byteLength)
               inflight = publishRun(fs, path, sst); written.push(runMeta(path, sst))
      yield  → await yieldToEventLoop()                                  // setTimeout(0): works in every SharedWorker
      done   → await inflight; return { inputs: plan.inputs, outputs: written, droppedSeq }
  catch e:
    await inflight?.catch(noop); for each written: fs.remove(path).catch(noop)
    if e is WebAssembly.RuntimeError: dropWasm(); rerun once with the TS core
    throw e
  finally: merge.close(); close every OpenFile
```

Re-running a step is idempotent: the plan and `top` are the same, so the
output names are the same, and `create` replaces. A crash mid-step leaves
unreferenced outputs, which the first `reclaim` of the next host lists and
removes, as today.

### Host policy (`host/budget.ts`, one pure function)

Every derived knob comes from one function, so the formula has a single home:

```ts
export function hostBudget(compactionMemoryBytes: number): HostBudget
// → { chunkBytes, maxSources, flushRunBytes, outputRunBytes: TARGET_RUN_BYTES,
//     yieldBytes, wasmRecycleBytes }
```

- **Planner cap.** `planCompaction(runs, { maxSources })`. An Ln step has 2
  sources and never needs a cap. An L0 step takes the *oldest* `maxSources − 1`
  L0 runs plus the L1 slice as one source. Leaving newer L0 runs in front is
  correct: they are newer than everything in the step. The step's byte size is
  deliberately uncapped; memory no longer depends on it.
- **One merge per SharedWorker.** A host-wide `mergeSlot` (async mutex)
  serializes merge sessions across databases, which is also why wasm needs
  only one session slot. A database's budget is the smallest
  `compactionMemoryBytes` any of its tabs passed (same rule as `maxWalBytes`).
- **Bounded flush.** `ingestAll` folds the oldest uningested records up to
  `flushRunBytes` of op bytes (at least one WAL record), publishes that L0 and
  a generation, advances `ingestedThrough`, and repeats until `through`, taking
  the ingest lock per chunk so an `installStep` can interleave. Each chunk is
  the same idempotent transition as today's single ingest. `IdBWal.listUningested({ maxBytes })`
  reads by seq range and stops past the cap. L0 runs never exceed
  `flushRunBytes`, so every run in the system is at most `max(T, F)` and every
  run tail is bounded.
- **Yielding.** Every NEED awaits real OPFS reads (a task boundary), and YIELD
  forces one every `yieldBytes` (default 1 MiB) of input. A step therefore
  holds the event loop for about a millisecond at a time, and ingest messages
  are served during a 400 MB step.
- **Wasm memory.** No fixed slab. The session reserves its working set at
  `merge_open` (fails with -11, never traps); the pump allocates only to grow
  a scratch buffer (oversized block, tail, entry slot), always with
  try_reserve. Flush `encode_sst` is bounded by `flushRunBytes`. Talc still
  never shrinks memory, so the host **recycles the instance** at idle points
  (no session open, after a compaction pass or a flush) when
  `memory.buffer.byteLength > wasmRecycleBytes`: instantiate a fresh instance
  synchronously from the cached `WebAssembly.Module` and drop the old one.
  This needs `useLz4Decoder`/`useBlockScanner` to read the current engine
  instead of capturing `mod`, and JS never to hold a view into wasm memory
  across an await (OUTPUT is copied out, which also makes concurrent ingest
  `encode_sst` calls safe while a merge is open).
- **TS fallback.** `store/merge-ts.ts` implements the same `MergeCore`
  interface: identical demand protocol, block decode through `sst.ts`
  `BlockEntries`, and output by buffering entries up to T then
  `sstTs.encodeSst` (raw only, as today). It is bounded by the same formula
  with about 3T instead of T for the output (JS objects plus encode). The
  driver cannot tell the cores apart.

### Tab memtable backpressure (`db.ts`, `memtable.ts`)

`Memtable` keeps `bytes` = Σ(key + value + 48) over live rows, updated in
`put` (replace subtracts the old row) and recomputed in `advanceTo`. In
`DbImpl.write`, before `appendAfter`:

```
while mem.bytes > memtableBytes:
  before = installed generation
  await this.ingestOnce()          // coalesced: one in-flight host.ingest(appliedThrough) per tab, then load the generation
  if installed generation == before: break   // no progress (host failing): let the write through rather than deadlock
```

The release valve is ingest, which is now bounded and no longer starved by
compaction. Rows pinned by an open `view` are not counted (pins keep old
chunks alive by design).

### Encoded invariants

- Only one merge implementation per language; the driver is the only caller
  (`openMerge` is the only export; `MergeSession` is crate-private behind the
  wasm exports).
- `CompactionPlan.sources` is the single source of truth; `inputs` is derived.
- The engine, not JS, owns offsets: JS cannot request a partial block or skip
  data, so the running CRC always sees every byte in order.
- `merge_feed` refuses a length that does not match the demand; `merge_pump`
  refuses to run with an unanswered demand.
- All budget arithmetic lives in `hostBudget`; tests pin its outputs.

### Interface depth

The public surface grows by two numbers in `OpenOptions`. Internally,
`openMerge` exposes four operations (`pump`, `feed`, `close`, plus the result
union) and hides block tables, read-ahead policy, CRC, the heap, duplicate
handling, output splitting and SST encoding. The driver is a 30-line loop of
I/O. JS learns nothing about the SST format.

## Type sketch

### Rust: `crates/engine-core/src/sst.rs` (writer)

```rust
/// Builds one SST v1 in file order in a single buffer. Keys must not
/// decrease. Reused across output runs via `reset`.
pub struct SstWriter {
    codec: Codec,
    out: Vec<u8>,                 // data blocks, then bloom | index | footer at finish
    block: BlockBuilder,          // records of the open block (≤ BLOCK_TARGET + one record)
    index: Vec<u8>,               // encoded index rows, appended per block
    hashes: Vec<u32>,             // fnv1a(key) per entry, for the bloom at finish
    entries: u32,
    blocks: u32,
    last_key: Vec<u8>,
    finished: bool,
}

impl SstWriter {
    /// Reserves `data_bytes` + slack with try_reserve.
    pub fn with_capacity(codec: Codec, data_bytes: usize) -> Result<Self, SstError> { todo!() }
    /// Appends one entry. OUT_OF_ORDER when `key` < the previous key.
    pub fn add(&mut self, tag: u8, seq: u64, key: &[u8], value: Option<&[u8]>) -> Result<(), SstError> { todo!() }
    /// Bytes of data blocks written so far, the open block included.
    pub fn data_len(&self) -> usize { todo!() }
    pub fn is_empty(&self) -> bool { todo!() }
    /// Closes the open block, appends bloom, index, footer (CRC over all of it). The run.
    pub fn finish(&mut self) -> &[u8] { todo!() }
    /// Ready for the next run; keeps capacity.
    pub fn reset(&mut self) { todo!() }
}

/// Unchanged signature; now sorts refs and drives `SstWriter`.
pub fn encode_sst(entries: &[Entry], codec: Codec) -> Vec<u8> { todo!() }

/// Footer → (bloom_offset, crc range, stored crc, block lengths). Checks that
/// blocks are contiguous from 0 to bloom_offset.
pub(crate) fn parse_tail(tail: &[u8], tail_at: usize, size: usize) -> Result<RunTail, SstError> { todo!() }

pub(crate) struct RunTail {
    pub bloom_offset: u32,
    pub block_lens: Vec<u32>,
    pub entry_count: u32,
    pub codec: Codec,
    pub crc_tail: u32,      // crc32(file[bloom_offset..crc_off])
    pub tail_len: u32,      // crc_off - bloom_offset
    pub stored_crc: u32,
}
```

### Rust: `crates/engine-core/src/merge.rs` (replaces `compact.rs`)

```rust
pub struct MergeSpec<'a> {
    pub sources: &'a [&'a [u32]],   // run sizes per source, newest source first
    pub drop_tombstones: bool,
    pub target_bytes: usize,
    pub codec: Codec,
    pub chunk_bytes: usize,
    pub yield_bytes: usize,
}

pub struct Demand { pub source: u16, pub run: u16, pub offset: u32, pub len: u32 }

pub enum Stop<'s> {
    Need(&'s [Demand]),
    Output(&'s [u8]),
    Yield,
    Done { dropped_seq: u64 },
}

pub struct MergeSession { /* see Shape */ }

impl MergeSession {
    /// Reserves every buffer the merge needs; -11 equivalent when it can't.
    pub fn open(spec: MergeSpec) -> Result<Self, SstError> { todo!() }
    /// Where to write the bytes answering `source`'s outstanding demand.
    pub fn feed(&mut self, source: u16, len: u32) -> Result<&mut [u8], SstError> { todo!() }
    pub fn pump(&mut self) -> Result<Stop<'_>, SstError> { todo!() }
}

struct Source {
    runs: Vec<u32>,
    run: usize,
    state: SourceState,
    blocks: Vec<u32>,
    next_block: usize,
    chunk: Vec<u8>,
    chunk_at: u32,
    chunk_pos: usize,
    block: Vec<u8>,
    cursor: RecordCursor,
    cur: Slot,
    look: Option<Slot>,
    crc_data: u32,
    tail: Option<RunTailCheck>,
}

enum SourceState { NeedTail, NeedTailRest { have: u32 }, Blocks, Exhausted }
enum Advance { Ready, NeedBytes(Demand), Exhausted }

impl Source {
    /// cur ← look; decode into look until the key changes (equal key: swap,
    /// so the run's last duplicate wins). At a run's end: CRC check, then
    /// NeedTail for the next run of the source.
    fn try_advance(&mut self) -> Result<Advance, SstError> { todo!() }
}
```

### Rust: `crates/engine-wasm/src/lib.rs`

```rust
static SESSION: Slot<Option<MergeSession>> = ...;

#[no_mangle] pub unsafe extern "C" fn merge_open(ptr: *const u8, len: usize, drop_tombstones: i32,
    target_bytes: f64, lz4: i32, chunk_bytes: u32, yield_bytes: u32) -> i32 { todo!() }
#[no_mangle] pub extern "C" fn merge_pump() -> i32 { todo!() }   // 1 NEED, 2 OUTPUT, 3 YIELD, 4 DONE, <0 error
#[no_mangle] pub extern "C" fn merge_feed(source: u32, len: u32) -> u32 { todo!() }
#[no_mangle] pub extern "C" fn merge_close() -> i32 { todo!() }
// merge_ssts removed. OUTPUT points result_ptr/result_len at the writer's buffer.
```

### TS: `packages/kv/src/store/engine.ts` (merge part)

```ts
export type MergeSpec = {
  /** Run sizes per source, newest source first. */
  readonly sources: readonly (readonly number[])[];
  readonly dropTombstones: boolean;
  readonly targetBytes: number;
  readonly codec: SstCodec;
  readonly chunkBytes: number;
  readonly yieldBytes: number;
};

export type Demand = { readonly source: number; readonly run: number; readonly offset: number; readonly length: number };

export type MergeStop =
  | { readonly kind: "need"; readonly demands: readonly Demand[] }
  | { readonly kind: "output"; readonly sst: Uint8Array }   // a copy; safe across awaits
  | { readonly kind: "yield" }
  | { readonly kind: "done"; readonly droppedSeq: number };

/** One merge in progress. Answer every demand of a `need` before the next pump. */
export interface MergeCore {
  pump(): MergeStop;
  feed(source: number, bytes: Uint8Array): void;
  close(): void;
}

/** Wasm when loaded, else the TS core. Throws RuntimeError on a trap (caller drops wasm). */
export async function openMerge(spec: MergeSpec): Promise<MergeCore> {
  throw new Error("not implemented");
}

/** Host only: a fresh instance when the old one's memory passed `maxBytes` and no session is open. */
export function recycleEngine(maxBytes: number): boolean {
  throw new Error("not implemented");
}

export function engineMemoryBytes(): number {
  throw new Error("not implemented");
}
```

### TS: `packages/kv/src/store/merge-ts.ts`

```ts
/** The TS core of `openMerge`: same protocol, raw output, bounded by the same knobs. */
export function openMergeTs(spec: MergeSpec): MergeCore {
  throw new Error("not implemented");
}
```

### TS: `packages/kv/src/store/levels.ts`

```ts
export type CompactionPlan = {
  /** Newest first. A source is one L0 run or a key-ordered slice of one level. */
  readonly sources: readonly (readonly RunMeta[])[];
  readonly outputLevel: number;
  readonly bottom: boolean;
};

export function planInputs(plan: CompactionPlan): readonly RunMeta[] {
  return plan.sources.flat();
}

export function planCompaction(
  runs: readonly RunMeta[],
  limits: { readonly maxSources: number; readonly l1Target?: number },
): CompactionPlan | undefined {
  // L0 step: oldest min(l0.length, maxSources - 1) L0 runs, each its own source,
  //          then the overlapped L1 slice as one source.
  // Ln step: [pick], [overlapped Ln+1 slice].
  throw new Error("not implemented");
}
```

### TS: `packages/kv/src/host/budget.ts`

```ts
export const DEFAULT_COMPACTION_MEMORY = 32 * 1024 * 1024;
export const MIN_COMPACTION_MEMORY = 24 * 1024 * 1024;

export type HostBudget = {
  readonly chunkBytes: number;      // read-ahead per source
  readonly maxSources: number;      // planner cap, 2..16
  readonly flushRunBytes: number;   // op bytes per L0 run
  readonly yieldBytes: number;
  readonly wasmRecycleBytes: number;
};

/** The only place the memory formula lives (see "Memory budget arithmetic"). */
export function hostBudget(compactionMemoryBytes: number): HostBudget {
  throw new Error("not implemented");
}
```

### TS: `packages/kv/src/host/compact.ts`, `ingest.ts`, `engine-host.ts`

```ts
export async function mergeNextStep(
  fs: AsyncFs, base: GenerationMeta | undefined, knownTop: number, budget: HostBudget,
): Promise<CompactionOutput | undefined> {
  throw new Error("not implemented"); // driver loop from Shape
}

/** Folds the oldest uningested records, `maxRunBytes` of ops per L0 run, until `through`. */
export async function ingestAll(
  wal: IdBWal, fs: AsyncFs, through: number, trust: (g: number) => boolean,
  maxRunBytes: number, exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<IngestResult> {
  throw new Error("not implemented");
}

// engine-host.ts
//   private readonly mergeSlot = new Mutex();           // one merge per SharedWorker
//   private budgets = new Map<DbName, number>();         // smallest compactionMemoryBytes per db
//   watch(name, policy)                                   // policy gains compactionMemoryBytes
//   after each compactPass / fold: if (!mergeSlot.held) recycleEngine(budget.wasmRecycleBytes)
//   stats(name).memory = { wasmBytes, wasmPeakBytes, mergeReservedBytes, recycles }
```

### TS: `packages/kv/src/db.ts`, `memtable.ts`, `idb/wal.ts`

```ts
export type OpenOptions = {
  readonly name: string;
  readonly memoryBudget?: number;
  /** Bytes of rows this tab holds that are not in OPFS yet. Writes wait for ingest past it. Default 32 MiB. */
  readonly memtableBytes?: number;
  /** SharedWorker bytes for one merge and one flush. Default 32 MiB, min 24 MiB. */
  readonly compactionMemoryBytes?: number;
};

// Memtable: get bytes(): number   — Σ(key + value + ROW_OVERHEAD) of live rows
// IdBWal:   listUningested(opts?: { maxBytes?: number }): Promise<WalRecord[]>   // oldest first, ≥ 1 record
```

## Module map

| File | Change |
|---|---|
| `crates/engine-core/src/sst.rs` | + `SstWriter`, `parse_tail`; `encode_sst` drives the writer |
| `crates/engine-core/src/merge.rs` | new, replaces `compact.rs`: `MergeSession`, `Source`, heap |
| `crates/engine-core/src/crc32.rs` | `combine` becomes `pub` |
| `crates/engine-wasm/src/lib.rs` | + `merge_open/pump/feed/close`, − `merge_ssts` |
| `crates/engine-abi.md` | session calls, states 1 to 4, codes -13 to -16, memory section rewritten |
| `packages/kv/src/store/engine.ts` | `openMerge`, `recycleEngine`, `engineMemoryBytes`; − `mergeSsts`; fallback closures read the current engine |
| `packages/kv/src/store/merge-ts.ts` | new: TS `MergeCore` |
| `packages/kv/src/store/crc32.ts` | TS `crc32Combine` (or feed with `seed`, which it already takes) |
| `packages/kv/src/store/levels.ts` | `sources`, `maxSources` cap on L0 |
| `packages/kv/src/host/budget.ts` | new: `hostBudget` |
| `packages/kv/src/host/compact.ts` | driver loop |
| `packages/kv/src/host/ingest.ts`, `idb/wal.ts` | chunked ingest, capped listing |
| `packages/kv/src/host/engine-host.ts`, `protocol.ts` | budget per db, merge slot, recycle, stats.memory |
| `packages/kv/src/db.ts`, `store/memtable.ts`, `ingest-policy.ts` | options, `bytes`, backpressure |
| `bench/driver/chrome.ts`, `bench/driver/run.ts`, `bench/workloads/kv/*`, report | heap sampling of the SharedWorker and tabs, new columns, budget workload |

## Memory budget arithmetic

Knobs: `B = compactionMemoryBytes`, `M = memtableBytes`. Fixed: `T = TARGET_RUN_BYTES = 4 MiB`.
Derived by `hostBudget(B)`:

```
F  = clamp(B / 16, 1 MiB, T)                    flush run (op bytes)
C  = B >= 32 MiB ? 256 KiB : 64 KiB             read-ahead chunk per source
K  = 8 KiB + 2·E                                per-source block + cur/look slots, E = largest entry (≤ 64 KiB assumed)
τ  ≈ 0.03 · max run size  (≤ 150 KiB at 4 MiB) tail scratch: bloom + index of one run
W0 ≈ 1 MiB                                      module statics, CRC tables, stack, talc metadata
S  = clamp(floor((B − W0 − 3.1·T − 5·F − τ) / (2·C + K)), 2, 16)    max sources per step
```

Peak SharedWorker bytes for one merge plus one concurrent flush:

```
P_host = W0
       + S·(C + K)            wasm: chunk + block/slots per source
       + S·C                  JS: read results in flight (garbage until GC)
       + 1.03·T               wasm: output run being built (data + bloom/index/footer)
       + 2·T                  JS: the OUTPUT copy being written + the one just produced
       + τ
       + 5·F                  flush: WAL records + folded entries (≈2F JS), INPUT F, writer F, copy F
```

At the default `B = 32 MiB`: F = 2 MiB, C = 256 KiB, K ≈ 8 KiB, S = 16:
`1 + 16·0.26 + 16·0.25 + 4.12 + 8 + 0.15 + 10 ≈ 31.4 MiB`. A step's input bytes
do not appear. Today's formula is about `4 · step input` (160 MB for the
L0→L1 step at a full L1).

Wasm `memory.buffer.byteLength` is the high-water of the wasm terms:
`W0 + S·(C + K) + 1.03·T + τ + 2·F ≈ 15 MiB` at the default, and
`wasmRecycleBytes = 1.25 ×` that.

Stated slack: +25% for GC lag on read ArrayBuffers and talc fragmentation
(bounded by recycling), plus `(2S + 3)·E` for entries larger than 64 KiB.
Browser-internal buffering inside `createWritable` is outside the JS heap
and not counted.

Tab: `memtable ≤ M + one batch` (writes stop at M; one in-flight batch and
rows other tabs appended may land), plus the existing `memoryBudget` cache.
TS fallback: replace `1.03·T` by `≈ 3·T` (entries as JS objects, then encode),
and `5F` stays, so the fallback needs about `B + 8 MiB`; documented, not
enforced.

## Bench measurement

- **Ground truth.** `bench/driver/chrome.ts` already speaks raw CDP. Add
  `Target.setAutoAttach({ flatten: true })` for `shared_worker` targets and
  poll `Runtime.getHeapUsage` every 100 ms on the SharedWorker and each tab,
  recording peak `usedSize` and, where Chrome reports it,
  `backingStorageSize` (ArrayBuffers, wasm memory included).
- **Engine accounting.** `HostStats.memory` gives `wasmBytes`,
  `wasmPeakBytes` (sampled at every pump stop), `mergeReservedBytes`,
  `recycles`. This works in Safari and Firefox runs too, where CDP is absent.
- **Workloads.** A `kv/compaction-memory` workload reproducing the
  acceptance case (todo rows, 20 rounds × 100k), asserting
  `peak ≤ B · 1.25`. Report columns "host peak", "host wasm peak", "tab peak"
  on every kv workload. Throughput: `compare` on `kv/fillrandom --size large`
  and `kv/overwrite`, before and after, on one machine.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept a resumable state machine in Rust (pending advances, demands,
  per-run CRC state) in exchange for memory independent of step size and an
  allocation-free merge loop. It is the most complex part of the engine.
- We accept that a corrupt input is detected only when its last block is
  consumed, after outputs from it may exist on disk, in exchange for never
  holding a whole input. Installation is still gated on every CRC.
- We accept two merge cores (Rust and TS) behind one driver, as with the SST
  codec today, in exchange for a bounded fallback.
- We accept an uncapped step byte size. Memory no longer depends on it, but a
  400 MB step still holds the compaction lock for a long time and doubles its
  disk use until installed.
- We accept grow-then-recycle wasm memory instead of a hard slab, in
  exchange for never trapping on a budget miss (a trap drops wasm for the
  context).
- We accept a copy of each output run (4 MiB memcpy, about 1 ms) in exchange
  for no wasm views held across awaits, which makes recycling and concurrent
  ingest calls safe.
- We accept more and smaller L0 runs when ingest lags (F instead of one big
  run), in exchange for a bounded flush; the L0 cap on `maxSources` keeps the
  next L0 step bounded.

## Alternatives considered

- **Merge loop in TS, wasm per block** (decode a block, encode a block). Lost
  on depth and speed: the heap, duplicate rules, block cutting and bloom state
  would live in TS, with a wasm call and a copy per 4 KiB block in each
  direction. It also spreads the SST format across both sides.
- **Keep whole-run reads, cap step bytes in the planner** (split L0→L1 by key
  range, cap Ln+1 overlap). Smallest change, but the memory bound becomes
  `4 × step cap`, the cap has to be at least one run per input, and random
  keys still make every L0 run overlap every L1 run, so splitting multiplies
  write amplification. It treats the step size, not the representation.
- **Fixed slab via `init(capacity)`.** A hard bound, but every allocation site
  must return -11 instead of trapping, and any miss traps and drops wasm for
  the whole context. Session-time reservation plus recycling gets the same
  bound without that failure mode.
- **Stream output blocks straight to `createWritable`.** Would save up to T,
  but the path needs the final byte size and renames are off the table.

## Open questions and risks

- Is 32 MiB right as the default and 24 MiB as the minimum? The floor comes
  from `3.1·T + 5·F`. Should T shrink for small budgets, which changes run
  counts and tab bloom/index memory?
- Should the flush have its own knob, or stay inside `compactionMemoryBytes`
  as here?
- Long deep steps let L0 pile up (each extra L0 run is a read-amp hit for
  tabs). Do we want an L0 write slowdown (RocksDB's `level0_slowdown_writes_trigger`)
  or a `maxStepBytes` for latency? This design caps sources, not bytes.
- Is `Runtime.getHeapUsage.backingStorageSize` in the Chrome the bench uses?
  Without it, wasm and ArrayBuffer bytes come from engine accounting only.
- Values over 64 KiB: document the overshoot, or add `maxValueBytes` to
  `openDb`?
- The first wasm-trap-mid-session retry reruns the whole step in TS. Is a
  step-sized redo acceptable?
- Risk: resumability bugs at block, chunk, run and duplicate boundaries.
  Mitigate with a property test that drives sessions with random chunk sizes
  and random read-ahead answers against `decode_sst` plus a reference fold,
  and a counting-allocator test that the pump does not allocate once warm.
- Risk: throughput. More OPFS reads (about 1 per 256 KiB per source, batched
  in parallel) and one output copy, against no per-entry allocation and no
  whole-buffer copies. Expected neutral or faster; it must be measured
  against the 10 to 20% margin.

## Next implementation step

Write `SstWriter` in `sst.rs` and make `encode_sst` drive it, with a test that
the new encoder is byte-identical to the current one over the existing fuzz
corpus. Every later piece (session output, bounded flush) stands on it.
