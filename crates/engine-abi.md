# Engine WASM ABI

The contract between `packages/kv/src/store/engine.ts` and any engine
`.wasm`. Two implementations exist, `crates/engine-wasm` (Rust) and
`crates/engine-zig` (Zig). The loader does not know which one it has. A
module is conformant when `crates/engine-zig/harness.mjs` passes against
it.

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
    The bytes produced by the last successful operation.

encode_sst(ptr, len, lz4: i32) -> i32
    Input: entry records (below). Result: one SST.

decode_sst(ptr, len) -> i32
    Input: one SST. Result: entry records in key order. The record stream
    for a given SST is identical across implementations.

lz4_decompress(ptr, len, size: u32) -> i32
    Input: one LZ4 block body. Result: exactly `size` bytes, or -10.

scan_block_contains(ptr, len, lz4: i32, pat_ptr, pat_len) -> i32
    Input: one framed data block as the SST block index frames it (with
    the u32 size prefix when `lz4`), and a pattern list. Both live in the
    input region; `pat_ptr` may point anywhere inside it. Result: hit
    records in key order.

merge_ssts(ptr, len, drop_tombstones: i32, target_bytes: f64, lz4: i32) -> i32
    Input: blob list. Result: merge output (below).
```

## Wire formats

All integers little-endian.

```text
entry record     u8 tag (1 put, 2 del) · u64 seq · u32 key_len · key
                 · for put only: u32 value_len · value
pattern list     repeated: u32 len · bytes
hit record       u32 key_len · u32 value_len · key · value
blob list        u32 count · repeated: u32 len · bytes
merge output     u64 dropped_seq · u32 count · repeated: u32 len · sst
```

`target_bytes` is an `f64` so JS can pass `Number.MAX_SAFE_INTEGER` for
"one output run"; implementations saturate it to their address size.

## Error codes

```text
-1  TOO_SHORT          -5  TRUNCATED           -9  BAD_CODEC
-2  BAD_MAGIC          -6  BAD_TAG            -10  BAD_BLOCK (incl. LZ4)
-3  BAD_VERSION        -7  TRAILING_GARBAGE   -11  OUT_OF_MEMORY
-4  CRC_MISMATCH       -8  COUNT_MISMATCH     -12  PATTERNS_TRUNCATED
-99 other
```

The loader maps any negative status to `CorruptDatabaseError`, except
`-11`, which it reports as a capacity error naming the operation and the
input size so the host can be configured with a larger `init` capacity.

## Memory discipline

A zero-allocation implementation reserves `capacity` in `init` and serves
every call from that slab: the input region, an arena reset at the start
of each operation, and the result inside the arena. Peak need per
operation is bounded by the inputs: an encode or merge needs roughly the
sum of input bytes plus the output; a decode needs the SST plus its
expanded records. The loader's default capacity is set from the measured
peak of the largest merge the kv host performs at bench size `large`,
with headroom, and is documented next to the constant.
