# engine-zig

A port of `crates/engine-core` and `crates/engine-wasm` to Zig, on the flat
ABI in `crates/engine-abi.md`. It exists to compare a Zig build of the WASM
engine against the Rust build in `packages/kv/wasm` on equal footing. Nothing
in the package imports it.

## What it is

`engine.zig` holds the whole engine in one file: the SST codec, bloom filter,
CRC-32, the compaction merge, and an LZ4 block compressor and decompressor.
Zig's standard library has no LZ4, so the codec is written here.

Exports: `memory`, `init`, `input_ptr`, `result_ptr`, `result_len`,
`peak_bytes`, `encode_sst`, `decode_sst`, `lz4_decompress`,
`scan_block_contains`, `merge_ssts`. The module imports nothing.
`loader.mjs`'s `loadFlat` is the whole JS binding, and it loads any module on
the flat ABI, the Rust one included.

## Memory

The module allocates nothing after `init`. `init(capacity)` grows wasm memory
once by `capacity` rounded up to a 64 KiB page, and that slab serves every
later call. Memory never grows again; `harness.mjs` checks
`memory.buffer.byteLength` after every call.

The slab has no fixed split. `input_ptr(len)` always returns the slab's start,
or 0 when `len` exceeds the capacity. When an operation starts, it places its
arena at the first 16-byte boundary past the furthest input byte, so the input
gets exactly the bytes it uses and the arena gets the rest. The arena is a
bump allocator, reset at the start of every operation. Sort keys, the sorted
entries, block and index buffers, the LZ4 output buffer, decoded entries and
the result all come from it. The result stays valid until the next call. The
LZ4 compressor's 16 KiB hash table is on the stack.

When an operation needs more than the arena holds, it returns -11
(`OUT_OF_MEMORY`) with an empty result. Nothing is left half-allocated, since
the next operation resets the arena, so the module keeps working for inputs
that fit.

`peak_bytes()` is the high-water mark of slab use since `init`: input bytes
plus arena bytes, so a capacity at least that large runs the same work. The
harness prints it per operation. Measured on the harness data:

| Operation | Input | Peak |
|---|---|---|
| encode raw, 50k entries | 6.0 MiB | 22.0 MiB |
| encode lz4, 50k entries | 6.0 MiB | 18.3 MiB |
| decode raw SST, 50k entries | 5.4 MiB | 18.9 MiB |
| decode lz4 SST, 50k entries | 1.7 MiB | 15.2 MiB |
| merge 4x20k lz4 runs into 256 KiB runs | 2.7 MiB | 20.5 MiB |
| merge 4x20k lz4 runs into one run | 2.7 MiB | 30.9 MiB |

A merge rewinds the arena after each output run and keeps only the run's
bytes. Without that, the 256 KiB-run merge peaks at 32.4 MiB.

At scale the ratios settle: an encode peaks at about 2.75x its input bytes
(a 72.5 MiB input peaks at 199 MiB), and a merge at about 10x its
compressed input (20.8 MiB of LZ4 runs peak at 199 to 216 MiB), because the
decoded entries of every input run live in the arena at once. The kv
loader's default capacity in `packages/kv/src/store/engine.ts` is set from
these numbers. The encode cost is one copy of the input plus the sorted
entry table; the merge cost could drop by streaming runs instead of
decoding them whole, which this prototype does not do.

## Hostile input

Every length read from an SST is checked as `len > end - o` with `o <= end`,
never as `o + len > end`, because the sum wraps on wasm32 and a wrapped
check passes. An LZ4 size field above 255 bytes per input byte is reported
as corruption (-10), not as a capacity miss. The kv differential fuzz suites
(`packages/kv/fuzz`) run against this module when it is copied to
`packages/kv/wasm/engine.wasm`; they pass except the test that expects a
trap on an oversized LZ4 size, which this module rejects with a status
instead. The build has no runtime bounds checks (`ReleaseSmall`), so a
missed check is a trap, not an error, and the fuzz suites are the gate.

## Build and run

Needs Zig 0.16 and a Rust build in `packages/kv/wasm`: `engine.wasm` on the
flat ABI, or the wasm-bindgen files as a fallback.

```sh
./build.sh          # engine_small.wasm (ReleaseSmall) and engine_fast.wasm (ReleaseFast)
node harness.mjs    # parity against Rust, capacity check, sizes, timings, peak_bytes, memory growth
node dec_ab.mjs     # LZ4 decoder checked block by block against Rust, then timed
node explain.mjs    # isolates the sort cost of encode and the LZ4 cost of decompression
```

## Results

Parity, all measured by `harness.mjs`:

- Raw SST encoding is byte-identical to the Rust build.
- Each side decodes the other's LZ4 runs. Zig output is 0.2% smaller than
  lz4_flex on the harness data.
- Block scan and merge, including the duplicate-key and tombstone rules,
  produce identical bytes.
- A corrupted byte is rejected by both with `CRC_MISMATCH`.

Size, gzip: Zig ReleaseSmall 10.5 kB, ReleaseFast 18.8 kB. Moving to the
fixed slab removed `wasm_allocator` and `ArenaAllocator` and saved 1.1 kB and
2.0 kB respectively.

`docs/research/lz4-zig-optimization.md` is the source for the LZ4 codec's
design choices.
