# engine-zig

A prototype port of `crates/engine-core` and `crates/engine-wasm` to Zig. It
exists to answer one question: what a Zig build of the WASM engine would cost
and buy against the Rust build in `packages/kv/wasm`. It is not wired into the
package and nothing imports it.

## What it is

`engine.zig` holds the whole engine in one file: the SST codec, bloom filter,
CRC-32, the compaction merge, and an LZ4 block compressor and decompressor.
Zig's standard library has no LZ4, so the codec is written here.

The exports take and return packed bytes instead of JS objects. JS writes
entries into WASM memory as `tag, seq, key length, key, value length, value`
records and reads results the same way. There is no generated glue; the
harness's `loadZig` is the whole binding.

## Build and run

Needs Zig 0.16 and the Rust build present in `packages/kv/wasm`.

```sh
./build.sh          # engine_small.wasm (ReleaseSmall) and engine_fast.wasm (ReleaseFast)
node harness.mjs    # parity against the Rust build, binary sizes, timings
node dec_ab.mjs     # LZ4 decoder checked block by block against lz4_flex, then timed
node explain.mjs    # isolates the sort cost of encode and the LZ4 cost of scan
```

## Results

Parity, all measured by `harness.mjs`:

- Raw SST encoding is byte-identical to the Rust build.
- Each side decodes the other's LZ4 runs. Zig output is 0.2% smaller than
  lz4_flex on the harness data.
- Block scan and merge, including the duplicate-key and tombstone rules,
  produce identical bytes.

Size, gzip: Rust 39 kB of WASM plus 21 kB of glue, Zig ReleaseSmall 11.6 kB
plus about 1.5 kB of glue.

Speed, 50k entries, from `harness.mjs` and `dec_ab.mjs`: encode and decode
are two to four times faster than the Rust build, but that gain is the
flat-bytes ABI, not the language. The Rust build spends most of its time in
wasm-bindgen marshalling and would gain the same from the same ABI. Merge,
where both sides already pass bytes, is the fair comparison: Zig is within
10% of Rust. Isolated LZ4 decompression is 1.8x faster than lz4_flex.

`docs/research/lz4-zig-optimization.md` is the source for the LZ4 codec's
design choices.
