# Engine WASM ABI

The contract between `packages/kv/src/store/engine.ts` and any engine
`.wasm`. `crates/engine-wasm` (Rust) implements it. The loader does not
know which implementation it has, so another language can provide a
module without touching the loader. A module is conformant when the kv
unit and fuzz suites pass with it copied to `packages/kv/wasm/engine.wasm`.

## Shape

The module imports nothing and exports `memory` plus the functions below.
Integers are `u32` unless stated. Every function that does work returns an
`i32` status: `0` is success, a negative value is an error code from the
table at the end. On error the result is empty.

JS never allocates or frees. It asks for an input region, writes bytes into
it, calls one operation, reads the result, and is done. Both regions are
valid only until the next call into the module.

```text
init(capacity: u32) -> i32
    Called once after instantiation. `capacity` is the number of bytes the
    module may use for all work (inputs, scratch, results). An
    implementation that allocates dynamically may ignore it and return 0.
    An implementation that reserves once must reserve here and never grow
    memory afterwards. Returns -11 (OUT_OF_MEMORY) when it cannot reserve.

input_ptr(len: u32) -> u32
    Address of an input region of at least `len` bytes. JS writes the
    packed arguments of the next operation there. Returns 0 when `len`
    does not fit the capacity. The region may move between calls.

result_ptr() -> u32
result_len() -> u32
    The bytes produced by the last successful operation. After a merge
    session's WRITE they point into the session's own output buffer.

encode_sst(ptr, len, lz4: i32) -> i32
    Input: entry records (below). Result: one run record (below), the SST
    and what the encoder knows about it.

lz4_decompress(ptr, len, size: u32) -> i32
    Input: one LZ4 block body. Result: exactly `size` bytes, or -10.

scan_block_contains(ptr, len, lz4: i32, pat_ptr, pat_len) -> i32
    Input: one framed data block as the SST block index frames it (with
    the u32 size prefix when `lz4`), and a pattern list. Both live in the
    input region; `pat_ptr` may point anywhere inside it. Result: hit
    records in key order.
```

### Merge session

A compaction step runs as a session the host pumps, so the module holds a
window of each input instead of the whole input. A module holds at most
one session.

```text
merge_open(ptr, len, drop_tombstones: i32, target_bytes: f64, lz4: i32,
           chunk_bytes, tail_bytes, yield_bytes) -> i32
    Input: source list (below), newest source first, then the base
    manifest's marks block, which the session copies without checking it:
    the host encoded it, and a malformed block traps. Reserves the working
    set: about `chunk_bytes` per source plus the output buffer. Returns 0,
    -13 while a session is open, -5 for a malformed list, -1 for a run
    shorter than a footer, or -11 when the working set cannot be reserved.

merge_pump() -> i32
    Merge until the host has to act, always between two keys. Returns
      1 NEED     result: demand records. Read each, `merge_feed` it, pump.
      2 WRITE    result: the next bytes of the open output run, in the
                 session's buffer. Copy them out before the next call.
      3 RUN_END  result: run head (below) · first_key · last_key. Every byte
                 of the run was in a WRITE.
      4 YIELD    about `yield_bytes` of input were merged; result empty.
      5 DONE     result: u64 dropped_seq. Every run's CRC matched.
    or a negative error code. -16 (UNFED) means a demand was not fed yet
    and leaves the session as it was; any other error is final, every later
    pump returns it, and no output of the session may be installed.

merge_feed(source, len) -> u32
    Address where the `len` bytes of `source`'s demand go. JS writes
    exactly `len` bytes there before the next call. 0 when `source` has no
    unfed demand of that length.

merge_close() -> i32
    Drop the session and its buffers. Returns 0, with or without one open.
```

A session asks for whole blocks only. For each run it first reads the last
`min(size, tail_bytes)` bytes, which hold the footer and usually the index,
then the rest of the bloom and index if the tail missed them, then its data
blocks in order, up to `chunk_bytes` per read. When the tail holds the whole
run, that one read is all. A NEED lists every source that cannot go on,
plus a read-ahead for each source holding less than half a chunk.

A source is runs read back to back as one key-ordered stream. Across
sources the newest wins; within a source the last duplicate of a key wins,
across block and run boundaries. A source whose keys go back fails with -14.
Output runs are cut at key boundaries once their entries, sized as entry
records (below), reach `target_bytes`, and written with `lz4`'s codec.
A winner whose seq is at or below the highest `through` among the marks
that hold its key is dropped, delete or put, and its seq is not a dropped seq.

## Wire formats

All integers little-endian.

```text
entry record     u8 tag (1 put, 2 del) · u64 seq · u32 key_len · key
                 · for put only: u32 value_len · value
pattern list     repeated: u32 len · bytes
hit record       u32 key_len · u32 value_len · u64 seq · key · value
run record       u32 entries · u32 size · u32 first_key_len · u32 last_key_len
                 · sst (size bytes) · first_key · last_key
source list      u32 count · repeated: u32 run_count · run_count × u32 size
demand record    u32 source · u32 run · u32 offset · u32 len
run head         u32 entries · u32 size · u32 first_key_len · u32 last_key_len
marks block      u32 count · per mark: u32 start_len · start · u8 has_end
                 · (u32 end_len · end, when has_end is 1) · u64 through
                 · u64 at. The end is exclusive, no end is the end of the
                 key space. The module ignores `at` and `count`: it reads
                 marks to the end of the block, so an empty block is no marks
```

A run record carries what the manifest records about a run, so the caller
never reads the SST back for it. `entries` is 0 for an empty run, whose two
keys are empty; it is what tells an empty run from one whose only key is
the empty key. The keys follow the SST because the encoder only knows them
when the run is complete.

`target_bytes` is an `f64` so JS can pass `Number.MAX_SAFE_INTEGER` for
"one output run"; implementations saturate it to their address size.

## Error codes

```text
-1  TOO_SHORT          -5  TRUNCATED           -9  BAD_CODEC          -13  SESSION_OPEN
-2  BAD_MAGIC          -6  BAD_TAG            -10  BAD_BLOCK (incl. LZ4) -14  OUT_OF_ORDER
-3  BAD_VERSION        -7  TRAILING_GARBAGE   -11  OUT_OF_MEMORY       -15  NO_SESSION
-4  CRC_MISMATCH       -8  COUNT_MISMATCH     -12  PATTERNS_TRUNCATED  -16  UNFED
-99 other
```

The loader maps any negative status to `CorruptDatabaseError`, except
`-11`, which it reports as a capacity error naming the operation and the
input size so the host can be configured with a larger `init` capacity,
and -13, -15 and -16, which are host bugs, not corrupt data.

## Memory

The Rust module allocates dynamically. `init` ignores `capacity` and
returns 0, `input_ptr` grows a reused input buffer, and an operation
allocates what it needs through the module's allocator. Outside a merge
session it never returns -11; running out of memory inside an operation
aborts, which the loader sees as a `WebAssembly.RuntimeError` and answers
by replacing the instance and throwing. A merge session
reserves its working set in `merge_open` and grows its input buffers (for
a block, a run's bloom and index, or an entry larger than any before)
without aborting, so it returns -11 instead. The output writer's per-run
state (one bloom hash per key and one index row per block of the open
run) still grows with the run, bounded by `target_bytes`, and running
out of memory there aborts as it does outside a session.

The contract carries `capacity` and -11 so that an implementation that
reserves once in `init` and serves every call from that slab can conform
without a loader change. Such an implementation must return -11, never
trap, when an operation exceeds the slab. The loader passes a capacity
sized for that case; a dynamic implementation ignores it.
