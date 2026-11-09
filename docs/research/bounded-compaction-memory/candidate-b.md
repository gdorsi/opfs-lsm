# Candidate B: bound the work, not the merge

Direction: the merge engine stays whole-buffer. Every call into it is made small by construction. A step is cut into key-range slices, each slice reads only the blocks it needs, merges, writes its output runs to disk, and drops everything. The slices of one step install together as one generation, so the leveled invariants never see a half-compacted state.

## Problem

A compaction step holds its inputs and outputs in memory, about 4x the step's input bytes (issue #101). The step size is unbounded: an L0 step spans all of L1 (~40 MB), so ~160 MB peaks. Wasm memory never shrinks, so the SharedWorker keeps its largest step's footprint. The one synchronous wasm call also blocks the SharedWorker event loop for the whole step, so ingest lags and the WAL and the tab memtable grow without limit. Ingest has the same shape: `ingestAll` folds the whole backlog into one L0 run (a 73 MB flush needs ~200 MiB). The tab memtable has no cap and writes never wait.

Constraints honored:
- The SharedWorker can only use async OPFS. Wasm calls are sync, so any streaming has to be driven from JS. This design makes JS the driver and needs no nested worker.
- Only already-used APIs: ranged `File.slice` reads, `createWritable` writes, held `OpenFile`s. No rename, no new browser API.
- Merge semantics are preserved: newest run wins, tombstones drop only on `bottom`, `droppedSeq`, output split at key boundaries, crash leaves only unreferenced files, and corrupt input is rejected before install.
- The TS fallback must stay correct. It is bounded by the same slicer, with a smaller slice.

## Usage (caller's view)

App code sees two new options and nothing else.

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({
  name: "todo",
  memoryBudget: 256 * MiB,        // existing: tab page cache
  compactionMemoryBytes: 64 * MiB, // NEW. SharedWorker transient memory for compaction and flush. Default 64 MiB, min 32 MiB.
  memtableBytes: 64 * MiB,         // NEW. Tab memtable cap. A write waits for ingest above it. Default 64 MiB, min 1 MiB.
});

await db.put(k, v); // may take longer than usual only when the memtable is full and ingest is behind
```

Host side, the call site in `compactPass` goes from "plan, read all, merge all" to a bounded driver:

```ts
// host/engine-host.ts, compactPass (the loop shape is unchanged)
const step = await mergeNextStep(fs, this.compaction(dbName), base, meta.top);
if (!step) return;
await this.exclusive(dbName, () => installStep(fs, wal, step, ...)); // unchanged: one generation per step
```

Bench and test call site (Node, `MemoryFs`, scaled-down constants):

```ts
const gauge = new MemoryGauge();
const ctx = compactionContext({ budgetBytes: 2 * MiB, targetRunBytes: 128 * KiB, gauge });
await mergeNextStep(fs, ctx, base);
expect(gauge.peak).toBeLessThanOrEqual(peakCompactionBytes(ctx.sliceBytes, nInputs, ctx.targetRunBytes));
```

Stats the bench reads (added to the existing host stats): `wasmBytes` (the high-water mark, since memory never shrinks), `peakGaugeBytes`, `slices`, `capacityRetries`.

## Shape

### Data structures

**1. SST v2 (the one format change).** Data blocks stay byte-identical, so read speed is untouched. The index and footer change:

```
index entry v1: first key · last key · u32 offset · u32 length
index entry v2: first key · last key · u32 offset · u32 length · u32 crc · u32 rawLen
footer v1: ... · CRC32(all preceding bytes) · version · magic
footer v2: ... · tailCrc = CRC32(bloom · index · footer fields before it) · version=2 · magic
```

- `crc` is the CRC32 of the block's framed bytes. A slice can verify exactly the blocks it reads. Whole-file CRC is gone, so there is no way to verify a ranged read against it.
- `rawLen` is the decoded block size. The slicer plans on decoded bytes, which are exact for raw and lz4 alike. Today the lz4 expansion is only guessed ("about 10x").
- `tailCrc` protects the index, so the slice boundaries and offsets can be trusted.
- Together `tailCrc` plus the per-block CRCs cover every byte the old whole-file CRC covered.
- Cost: 8 B per 4 KiB block (0.2%). The TS reader's index parse widens its stride and ignores the new fields.

**2. `RunLayout`** (TS, per input run, parsed from the tail with the same code `SstReader` already uses; export `parseRunLayout`):

```ts
type RunLayout = {
  readonly firstKeys: readonly Uint8Array[]; // per block, exact
  readonly offset: Uint32Array;              // per block, + end sentinel
  readonly crc: Uint32Array;
  readonly rawLen: Uint32Array;
  readonly codec: SstCodec;
};
```

A flat array of keys is ~40 B per block, so ~40 KB per 4 MiB run.

**3. `Slice`**, the unit of work:

```ts
type Slice = {
  readonly lo: Uint8Array | undefined; // inclusive, undefined = -inf
  readonly hi: Uint8Array | undefined; // exclusive, undefined = +inf, which means this is the last slice
  /** Per input run, index-aligned with plan.inputs; a block range [from, to) or undefined when the run has none. */
  readonly parts: readonly (BlockRange | undefined)[];
  readonly decodedBytes: number; // sum of rawLen over parts
};
type BlockRange = { readonly from: number; readonly to: number };
```

**4. Memory model**, one module, the single source of truth for every formula:

```ts
// store/budget.ts (pure)
export const PEAK_PER_DECODED_BYTE = 4.5; // wasm 3.5 + JS read buffers 1.0
export const PEAK_PER_TARGET_RUN = 6.75;  // encode scratch 2.75 + carry-in decode 2 + carry JS 1 + out copy 1
export const PEAK_PER_INPUT = 48 * 1024;  // parsed layout + 2 straddling blocks
export function sliceBytesFor(budget: number, nInputs: number, targetRun: number): number;
export function peakCompactionBytes(sliceBytes: number, nInputs: number, targetRun: number): number;
export function ingestChunkBytesFor(budget: number, targetRun: number): number; // min(targetRun, budget / 6.25)
export function wasmCeilingFor(budget: number, targetRun: number): number;
```

### Engine ABI

`merge_ssts` (whole-SST blobs) is deleted and replaced by `merge_slice`, which is the same merge over block ranges. There is one way to merge, and the old whole-file case is a slice with no bounds. This removes the "two ways to do one task" red flag.

```text
merge_slice(ptr, len) -> i32      ; everything packed in the input region, like blob lists today
input:  u8 drop · u8 lz4 · u8 final · f64 target_bytes
        · u32 lo_len · u32 hi_len (0xFFFFFFFF = unbounded) · lo · hi
        · u32 carry_len · carry          ; entry records, all keys < lo, from the previous slice
        · u32 source_count               ; newest first
          · per source: u8 codec · u32 block_count · per block: u32 crc · u32 len · framed bytes
output: u64 dropped_seq · u32 run_count · runs (u32 len · sst) · u32 carry_len · carry
```

Rust: verify each block's CRC, then decode it with the existing `read_block`. Skip entries below `lo` and stop at `hi`. Run the existing heap merge with the carry as an extra source. Cut output runs at `target_bytes`. When `!final`, the last partial run is not encoded but returned as `carry` (entry records, which is the existing `decode_sst` output format). Output runs are therefore full-sized, so slicing does not fragment the level.

`init(capacity)` becomes real: a **ceiling** on linear-memory growth, not an up-front reservation, so `memory.buffer.byteLength` follows the use. Past it the allocator fails. Failure is either `-11` or a trap, and both are handled below.

### Planner (`store/levels.ts`, pure, gains `nextSlice`)

`planCompaction` still decides which runs go in (the run set). It is unchanged apart from the engine constants. The new function cuts that set:

```ts
/**
 * The slice of the step that starts at `from` (undefined = the beginning) and holds
 * at most `budgetDecoded` decoded bytes, unless one block alone is bigger.
 * Pure: reads layouts only. Blocks are charged to the slice they start in; a block
 * straddling the cut is also read by the next slice (<= one block per input).
 * Cut points are block first-keys, so a cut is always a real key.
 */
export function nextSlice(
  layouts: readonly RunLayout[],
  from: Uint8Array | undefined,
  budgetDecoded: number,
): Slice | undefined {
  // TODO
  //  1. per run: start = first block b with lastKey(b) >= from (binary search on firstKeys; step back one block).
  //  2. k-way merge the runs' remaining block firstKeys in key order (heap of run cursors).
  //  3. acc = sum of rawLen of the blocks from step 1 (the straddlers, counted up front).
  //     Pop the next block; if acc > 0 and acc + rawLen > budgetDecoded, then hi = that block's firstKey, stop.
  //     Otherwise acc += rawLen, extend that run's `to`.
  //  4. when the heap empties, hi = undefined (last slice).
  //  5. return undefined when no run has a block at or after `from`.
  throw new Error("not implemented");
}
```

It is incremental (one slice per call) so the driver can halve the budget and re-ask when the engine reports out of capacity. That makes the memory constants self-calibrating. Cost is O(blocks log runs) per slice, and block counts are in the tens of thousands.

### Driver (`host/compact.ts`)

```ts
export type CompactionContext = {
  readonly engine: () => FlatEngine;       // fresh after dropWasm
  readonly gate: MemoryGate;               // process-wide: one in-flight slice or ingest chunk at a time
  readonly budgetBytes: number;
  readonly targetRunBytes: number;
  readonly gauge?: MemoryGauge;            // tests and bench
  readonly yieldToHost: () => Promise<void>; // scheduler.yield() / MessageChannel
};

export async function mergeNextStep(
  fs: AsyncFs, ctx: CompactionContext, base?: GenerationMeta, knownTop = 0,
): Promise<CompactionOutput | undefined> {
  // plan = planCompaction(meta.runs); top as today
  // files   = await Promise.all(plan.inputs.map(r => fs.open(r.path)))       // OpenFile: pinned against reclaim for the episode
  // layouts = await Promise.all(files.map(readRunLayout))                    // ranged tail read, verifies tailCrc, throws CorruptDatabaseError
  // let budget = sliceBytesFor(ctx.budgetBytes, plan.inputs.length, ctx.targetRunBytes)
  // let from: Uint8Array | undefined; let carry = EMPTY; let n = 0; const outputs = []; let droppedSeq = 0
  // try {
  //   for (;;) {
  //     const slice = nextSlice(layouts, from, budget); if (!slice) break
  //     try {
  //       await ctx.gate.run(async () => {
  //         const sources = await readParts(files, layouts, slice)             // Promise.all ranged reads, one per run
  //         const r = ctx.engine().mergeSlice({ sources, slice, carry, drop: plan.bottom,
  //                                             final: slice.hi === undefined, target, lz4: codecForLevel(outLevel) === "lz4" })
  //         for (const sst of r.runs) {                                        // one 4 MiB copy-out at a time, then write
  //           const path = levelRunPath(outLevel, `c${top + 1}.${n++}`, sst.byteLength)
  //           await publishRun(fs, path, sst); outputs.push(runMeta(path, sst))
  //         }
  //         carry = r.carry; droppedSeq = Math.max(droppedSeq, r.droppedSeq)
  //       })
  //     } catch (e) {
  //       if (!isCapacity(e) || budget <= MIN_SLICE_BYTES) throw e
  //       budget = budget / 2; continue                                        // trap => dropWasm() already ran; retry the same `from`
  //     }
  //     from = slice.hi; await ctx.yieldToHost()                               // lets ingest messages through
  //   }
  // } finally { await Promise.all(files.map(f => f.close())) }
  // return { inputs: plan.inputs.map(r => r.path), outputs, droppedSeq }
  throw new Error("not implemented");
}
```

- `installStep` is unchanged. A step is still one atomic generation swap.
- A capacity retry must not publish the half-written outputs of the failed slice twice. Output names use the running counter `n`, so the retry overwrites any orphan file with the same name (`create` truncates). A crash leaves unreferenced runs, as today.

### Ingest (`host/ingest.ts`)

`ingestAll` stops folding the whole backlog at once. It pulls WAL records in chunks of at most `W = ingestChunkBytesFor(budget)` (default `min(4 MiB, B/6.25)`), and each chunk goes through the gate:

```ts
// per chunk: records -> foldRecords -> publishL0 (staged file, unreferenced until the generation lands)
// after the last chunk: ONE publishGeneration { runs: [l0_k, ..., l0_1, ...prev], through: lastSeq },
//   then wal.advanceIngested(lastSeq, generation, foldedBytes).
```

- One generation per ingest call, so tabs reload once.
- A crash mid-way leaves unreferenced L0 files and the WAL still holding everything, so `reconcile` and `reclaim` already cope.
- Required WAL change: `listUningested(afterSeq, maxBytes)` pages by byte size. The IDB cursor transaction cannot span awaits, so each page is a fresh transaction after the last seq.
- A backlog becomes several L0 runs of ~W bytes instead of one giant run. The next compaction folds them, and it is bounded because it slices.

### Tab memtable (`store/memtable.ts`, `db.ts`)

- `Memtable.bytes`: incremental. `put` adds `rowBytes(row) = key.length + (value?.length ?? 0) + ROW_OVERHEAD(64)` and subtracts the replaced row. `advanceTo` recomputes from the kept rows.
- `Db.write()` (before `appendAfter`): `while (mem.bytes >= memtableBytes) await this.waitForIngest()`.
- `waitForIngest` asks the host to ingest through the current seq (an ingest-only request that does not wait for compaction) and resolves when `advanceTo` drops `bytes` below the low watermark, 50% of the cap.
- The cap is checked before an append, so overshoot is bounded by one batch. A batch bigger than the cap goes in when the table is empty (no deadlock).
- Records other tabs append arrive through `catchUp` and are not blocked, but each writer tab applies the same rule, so growth is bounded by the number of in-flight batches.
- Pinned views keep their rows alive past `advanceTo`. They are not counted, and they are bounded by view lifetime as today.

### Module map

| File | Change |
|---|---|
| `crates/engine-core/src/sst.rs` | SST v2: per-block `crc` and `rawLen` in the index, `tailCrc` footer |
| `crates/engine-core/src/compact.rs` | `merge_slice` (block sources, clip to `[lo, hi)`, carry, CRC checks). `merge_ssts` deleted |
| `crates/engine-wasm/src/lib.rs`, `crates/engine-abi.md` | `merge_slice` export, `init(capacity)` as a growth ceiling |
| `packages/kv/src/store/sst.ts` (TS codec) | v2 encode/decode, `parseRunLayout`, `mergeSliceTs` (fallback, same slicer, JS objects so the budget is divided by `TS_FALLBACK_FACTOR = 3`) |
| `packages/kv/src/store/sst-reader.ts` | index stride +8 B, ignore the new fields. No hot-path work |
| `packages/kv/src/store/engine.ts` | `mergeSlice` replaces `mergeSsts`. `ENGINE_CAPACITY = 1 GiB` becomes `wasmCeilingFor(budget)`. Idle recycle (`dropWasm` after 10 s without engine work) |
| `packages/kv/src/store/budget.ts` (new, pure) | memory constants and formulas, the only place they live |
| `packages/kv/src/store/levels.ts` | `nextSlice` (pure). `planCompaction` unchanged |
| `packages/kv/src/host/compact.ts` | bounded driver above. `installStep` unchanged |
| `packages/kv/src/host/ingest.ts`, `idb/wal.ts` | chunked fold, one generation, paged `listUningested` |
| `packages/kv/src/host/memory-gate.ts` (new, ~25 lines) | `MemoryGate` (async mutex) and `MemoryGauge` (peak counter) |
| `packages/kv/src/host/engine-host.ts` | builds the context from options, min over attached tabs per db; exposes stats |
| `packages/kv/src/store/memtable.ts`, `db.ts` | byte accounting, backpressure, `OpenOptions` |
| `bench/` | todo 20x100k run records `wasmBytes`, gauge peak, CDP `JSHeapUsedSize` of the SharedWorker target |

Depth check: callers of `mergeNextStep` give a context and get one atomic output. They never see slices, carry, CRC or ranges. `nextSlice` is a pure function of layouts, so the whole slicing policy is unit-testable with no OPFS and no wasm.

### Reading and verifying a key-range slice

- `readRunLayout(file)`: one ranged read of the last `min(size, 128 KiB)` (the `TAIL_GUESS` pattern in `sst-reader.ts`, extended if the index is larger). It verifies `tailCrc` in TS (about 100 KB, negligible), then parses.
- `readParts`: for each run with a `BlockRange{from,to}`, one `file.read(offset[from], offset[to] - offset[from])`, all in parallel. The bytes are cut into per-block `(crc, len, framed)` triples in the packed input. The block CRC is checked in Rust before decoding. A mismatch gives `-4`, which becomes `CorruptDatabaseError`, with nothing installed.
- Corruption found in slice k of a step means slices 1..k-1 only wrote staged files. Nothing is installed, same outcome as today.
- A block never read by any slice is never verified. Today that cannot happen, since the whole file is read. Here it does not happen either: the union of slices covers every block, and `final` is only reached when all runs are exhausted.

### Do sub-steps install one by one? No: all at once, staged on disk

Decision: slices stage output files; the step installs once.

- **Leveled invariants hold trivially.** Ln runs from L1 down never overlap, and outputs of consecutive slices are disjoint key ranges, so they meet that rule. No run is ever "partially consumed", so L0 needs no trimmed runs. A partially compacted L0 would need one of two things:
  - a virtual left-trimmed run (a narrowed `RunMeta.range`, a reader clip, and a `liveBytes` field so scores do not overstate), or
  - an L0 run rewrite.
- **Memory is still bounded.** The staged outputs are on disk, not in memory.
- **Crash semantics are identical to today.** Unreferenced outputs get swept.
- **Tab churn is identical.** One `announceGeneration` per step, not one per slice.
- **What it gives up:** progress is not durable mid-step, and L0 count stays high until the step ends (see Tradeoffs).

### Write amplification

- No change in bytes written. Each entry is rewritten once per step, as today.
- Extra reads: one straddling block per input per slice boundary, about 8 KiB x n per slice. For n=50 and a 7.9 MiB slice that is ~5%.
- The carry removes the small-tail-run effect that per-slice output would cause.
- This design does not cut the L0-into-L1 write amplification (each L0 step rewrites all overlapping L1). That is the leveled design's cost. Partial steps (phase 2 in Alternatives) are what would reduce it.

### Yielding

- Between slices the driver does `await ctx.yieldToHost()`. Inside a slice there are already OPFS awaits.
- The longest sync stall is one slice's merge: ~8 MiB at an assumed 60-100 MB/s is 80-130 ms, versus the whole step (seconds) today. `sliceBytes` is additionally capped at `SLICE_LATENCY_CAP = 16 MiB` so a large `compactionMemoryBytes` does not bring long stalls back.
- Ingest chunks take the same `MemoryGate` as slices, so an ingest waits for at most one slice. Gate order is FIFO, so ingest and compaction alternate and neither starves.

### Wasm memory

- A deterministic bound: every call's size is bounded (slice, ingest chunk), so the high-water mark is `max(W_c, W_i)`. `init(wasmCeilingFor(B))` enforces it as a growth ceiling.
- Past the ceiling, the allocator returns null. In the Rust `alloc` code that panics, so it traps (or the explicit `-11` is returned where checked). The host already handles traps by `dropWasm()` and a fresh instance. The driver treats trap or `-11` during a slice as "halve the slice budget, retry the same `from`", which also resets the memory. If it reaches `MIN_SLICE_BYTES` (1 MiB), it throws `EngineCapacityError`.
- Idle recycle: after 10 s with no engine work the host drops the instance, so a quiet SharedWorker returns to baseline.
- The TS fallback uses the same slicer with `budget / 3`, so it is bounded too.

### Memory arithmetic

Notation: `B` = `compactionMemoryBytes`, `T` = `TARGET_RUN_BYTES` (4 MiB), `D` = decoded bytes in a slice, `n` = number of inputs, `W` = ingest chunk bytes, `M` = `memtableBytes`.

Per slice:
- wasm: input framed `F ≤ D`, decoded entries `E ≈ 1.5 D` (key and value bytes plus `Vec` headers, assuming entries >= ~64 B), outputs `O ≤ D`, encode scratch of the run being built 2.75 T (measured in the comment in `engine.ts`), and the carry decoded again ≈ 2 T.
  `wasm_c = 3.5 D + 4.75 T`
- JS: read buffers `D`, one output run copy `T`, carry between calls `T`, layouts `n * 48 KiB`.
  `js_c = D + 2 T + n * 48 KiB`
- `Peak_c(D) = 4.5 D + 6.75 T + n * 48 KiB`
- Inverse (what `sliceBytesFor` computes): `D = min(16 MiB, (B - 6.75 T - n * 48 KiB) / 4.5)`.

Per ingest chunk `W ≤ T`:
- JS records `W`, folded entries `1.5 W`, wasm `2.75 W` (input included), result copy `W`.
  `Peak_i(W) = 6.25 W`, so `W = min(T, B / 6.25)`; at `T = 4 MiB` this is 25 MiB.

Process-wide (the gate lets only one of the two be in flight, so they do not add):

```
SharedWorker peak  =  baseline + max(Peak_c(D), Peak_i(W))  <=  baseline + B
wasm high-water    =  max(wasm_c(D), 2.75 W)                 <=  wasmCeilingFor(B) = 1.25 * wasm_c(D) + 2 MiB
tab                =  memoryBudget + M + one batch + pinned-view rows
```

Worked example (defaults `B = 64 MiB`, `T = 4 MiB`, `n = 32`):
- `D = (64 - 27 - 1.5) / 4.5 = 7.9 MiB`.
- `Peak_c = 64 MiB`, `wasm_c = 46.6 MiB`, ceiling = 60 MiB.
- A 160 MB step becomes ~20 slices.
- `B_min = 6.75 T + n * 48 KiB + 4.5 MiB = 33 MiB`, so the minimum is 32 MiB, validated at `openDb` (`RangeError` below it).
- At `B = 128 MiB`, `D = 20 MiB`, capped to 16 MiB.

Floors that are not budget-dependent: one block (or one entry bigger than a block, such as a 10 MB value) is read whole, so the budget cannot go below a few such entries. Documented, not enforced.

Honest note: `6.75 T` dominates at low budgets. It is a cost of fixed 4 MiB output runs, not of slicing. Two cheap Rust changes lower it, and neither is required for v1:
1. Decode into one arena with `(off, len)` entry refs: `E` falls from 1.5 D to ~1.1 D.
2. Encode without the second full copy: 2.75 T falls to ~1.5 T.

### Bench and verification

- Unit: `nextSlice` property tests. Any partition of the key space gives a covering, disjoint slice list, and each slice's `decodedBytes ≤ budget` unless it holds one block.
- Slice invariance (Rust and TS): for random inputs and random cut keys, the decoded entry stream of the concatenated slice outputs equals the stream of a single unbounded slice. This is the correctness proof for the whole design. It also covers `bottom` and `droppedSeq`.
- Gauge test (Node, `MemoryFs`, T scaled to 128 KiB): peak ≤ `Peak_c` for L0 steps of 40x the budget.
- Fuzz: v2 SST encode/decode round trip, flip one bit in each section (block, index, bloom, footer) and expect a reject, both via `decode_sst` and via `merge_slice`.
- `verify-kv`: existing merge and recovery checks, plus kill the worker between slices (all outputs unreferenced, no corruption).
- Bench (Chrome): todo example, 20 rounds x 100k. Record `memory.buffer.byteLength` per round, `JSHeapUsedSize` of the SharedWorker CDP target, and compaction MB/s versus main. Expect slices ≈ step/D and regression of 5-10% from boundary reads and per-slice calls. Anything over 20% means `D` is too small and the cheap Rust diet should land.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept an SST format change (v2: per-block CRC, `rawLen`, `tailCrc`) in exchange for verifiable ranged reads and exact decoded-byte planning. Reads are untouched; the fuzz and TS codec work is the price.
- We accept all-at-once install in exchange for trivially preserved invariants (no trimmed or virtual runs, no reader clipping). The price: no durable mid-step progress. A crash wastes the staged outputs, and L0 stays tall until the step ends.
- We accept that step length is unbounded: an L0 step still rewrites all overlapping L1 (the same write amplification as today). Only memory and stall time are bounded.
- We accept a 4.5x multiplier on slice bytes as the budget model. It is an estimate, backed by the ceiling plus halve-and-retry rather than by proof.
- We accept a process-wide `MemoryGate`, so a slow slice delays an ingest chunk by up to one slice (~100 ms) in exchange for peaks that do not add up.
- We accept ~5% extra read I/O (straddling blocks) and n parallel ranged reads per slice in place of one whole-file read per run.
- We accept that the budget has a floor of 32 MiB, because the 4 MiB output run size is fixed.
- We accept deleting `merge_ssts` and the whole-SST merge path, rather than keeping a fast path for small steps. A one-slice step is that fast path.
- `init(capacity)` as a ceiling and not a reservation looks like a semantic change to the ABI. It is deliberate: reserving would make `memory.buffer.byteLength` equal the ceiling from the start and defeat the measurement.

## Alternatives considered

- **A. Rust-side streaming merge session** (the other runner's direction): wasm holds a resumable merge, JS feeds blocks, and nothing is bounded by slice size. It has the lowest peak per byte and no boundary re-reads. It loses on depth of the engine: a stateful ABI (open, feed, next, close) that JS must drive in order, leaked state on a trap, and a harder TS fallback. This design keeps the engine a stateless function, which is easier to fuzz, and pays with a larger memory constant.
- **A2. No format change; verify by a streaming CRC pass.** Read every input once in 1 MiB chunks with an incremental CRC, then do the sliced merge. This keeps v1 files. It loses because it doubles input reads per step, plans lz4 slices on a guess, and lets a block be trusted only because a separate pass happened earlier.
- **B2. Install slice by slice with left-trimmed virtual runs** (Pebble-style virtual sstables): `RunMeta.range` becomes the live key bound, readers clip to it, the step is a sweep from the left, and each slice installs a generation. It would let L0 shrink in the middle of a long step, make progress durable, and allow partial L0 steps that cut write amplification. It loses for v1: it needs `liveBytes` in the manifest, reader clipping on every get and scan, a per-slice generation (tab reload churn), and trickier reclaim (a file lives until its last live byte is consumed). It stays the right phase 2 if step latency or L0 height proves to matter. The slicer and `merge_slice` here are what it would reuse.
- **C. Cut the plan, not the slice: a cap on the number of L1 runs per step** (L0 plus a few L1 runs). Rejected: an L0 run spans the whole key space, so a subset of L1 would still need the L0 run split or trimmed, which is B2.
- **D. Recycle the wasm instance after each large step.** It lowers resident memory afterwards but not the peak, so it does not meet "peak under budget". Used here only as an idle policy.
- **E. Separate budgets per stage (read, merge, write).** More knobs for the app and a leaky interface. One budget `B`, with internal derivation, hides the stages.

## Open questions and risks

1. Is the SST format change acceptable now? It touches the Rust encoder and decoder, the TS codec, the reader's index parse, fuzz, and `verify-kv`. If not, alternative A2 is the fallback, at the cost of one extra read pass per step.
2. Is a 32 MiB minimum and a 64 MiB default for `compactionMemoryBytes` right? Or should `T` scale with `B` (smaller output runs at smaller budgets, with `L1_TARGET = 10 T` following)? The planner would then see mixed run sizes after a budget change. That is harmless, but it is a bigger change.
3. Does the Rust allocator return null or trap at the ceiling? That decides whether halve-and-retry rides on `-11` or on the trap path (`dropWasm`). Both must be tested in Chrome, Safari and Firefox. Memory growth failure semantics also differ by browser.
4. The 1.5x entry-overhead assumption fails for tiny entries (<32 B). Should the bench calibrate `PEAK_PER_DECODED_BYTE` per workload, or is adaptive halving enough?
5. Should one wasm instance be shared by ingest and compaction (gate, max-not-sum), or should compaction own its own instance so the idle recycle does not hit ingest? The sharing assumed here depends on the flat ABI keeping no state between calls.
6. Does the host have an ingest-only request that does not wait for compaction (for `waitForIngest`)? If `flush()` always settles compaction, backpressure would wait on compaction too and could stall writes for a whole step. A new request type is needed, and `db.ts` should be checked.
7. If the SharedWorker's ingest is dead or stuck, writes wait on the memtable cap forever. Should the wait time out with an error, or rely on the host-liveness check that exists today?
8. Is a stall of ~100 ms per slice acceptable for the SharedWorker's other duties (ingest requests, tab messages)? If not, `SLICE_LATENCY_CAP` should come down to 4 MiB, at some cost in throughput.
9. Is read-ahead (reading slice k+1 while merging slice k) worth `+D` in the memory formula? Probably not at 64 MiB; a possible knob at 128 MiB or more.
10. What should happen to tombstone-heavy `bottom` steps when `droppedSeq` is the max over slices? `tombstoneSeq` is monotonic, so max is right, but the semantics need review in `verify-kv`.

## Next implementation step

Write `nextSlice` and the slice-invariance property test against the current TS codec (`mergeSliceTs` with block sources), because they define the contract that the SST v2 format, the Rust `merge_slice`, and the driver are all built against.
