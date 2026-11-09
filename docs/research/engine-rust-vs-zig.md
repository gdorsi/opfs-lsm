# Rust versus Zig for the kv WASM engine: the comparison

Measured 2026-11-09 on an Apple M5 Max (18 cores) under load averages of
7 to 15 from another workspace's stress run, Chrome 156 headless, Node 24,
Zig 0.16, Rust nightly. Both engines implement the flat-bytes ABI in
`crates/engine-abi.md`; the loader in `packages/kv/src/store/engine.ts`
cannot tell them apart. Rust is `crates/engine-wasm`, built by its
`build.sh`. Zig is `crates/engine-zig`, `ReleaseSmall`, zero allocation
after `init`.

## Verdict

Stay on Rust, with the flat ABI this round added. The end-to-end kv
benchmark cannot tell the two engines apart. On the engine alone Rust is
faster on raw encode and decode and tied elsewhere. Zig's gain is 9 kB
of gzipped bundle out of 49 kB after open, and it costs a 1 GiB slab
reservation, a build with no bounds checks that the fuzz suites had to
catch twice, and a pre-1.0 toolchain.

## End to end: `pnpm bench kv/`, size small, 5 reps

Rust and Zig ran interleaved in one Chrome session (rep 1 of each, then
rep 2, order rotated). Verdicts use the bench's rule: a difference only
when the min to max ranges do not overlap.

| workload | phase | Rust ops/s (min to max) | Zig ops/s (min to max) |
|---|---|---:|---:|
| fillrandom | fillrandom | 305k (229k to 332k) | 305k (231k to 326k) |
| fillrandom | readrandom | 505k (487k to 521k) | 514k (464k to 517k) |
| fillrandom | readmissing | 1534k (1491k to 1641k) | 1610k (1434k to 1704k) |
| fillrandom | coldopen | 91 (76 to 98) | 86 (77 to 106) |
| fillseq | fillseq | 372k (340k to 466k) | 366k (284k to 470k) |
| fillseq | readseq | 406k (385k to 514k) | 426k (261k to 529k) |
| fillseq | seekrandom-100 | 11.4k (11.3k to 12.7k) | 11.4k (10.9k to 12.8k) |
| overwrite | overwrite | 311k (208k to 359k) | 261k (246k to 318k) |
| deleterandom | deleterandom | 363k (338k to 399k) | 441k (305k to 747k) |
| ycsb-a | ycsb-a | 4380 (2860 to 7356) | 4445 (1293 to 8138) |
| ycsb-c | ycsb-c | 302k (236k to 380k) | 316k (254k to 395k) |
| ycsb-e | ycsb-e | 14.4k (11.7k to 17.1k) | 13.8k (12.8k to 16.9k) |

All 27 phases: no measurable difference. Zero phases favour either side.
The full record is `bench/results/2026-11-09T12-45-05-*.jsonl` on the
machine that ran it. Every read was checked against the model, so a wrong
value would have failed the run.

Baseline (main, wasm-bindgen) against the Rust flat ABI, run as two
separate passes about 25 minutes apart on the same noisy machine, also
gives no measurable difference on all 27 phases. The engine is not what
these workloads wait on; the WAL, IndexedDB and OPFS are.

## Engine alone: Node, interleaved, median of 21 (min to max), ms

| operation | Rust | Zig |
|---|---:|---:|
| encode raw, 50k entries | 14.0 (13.4 to 16.3) | 21.2 (20.4 to 35.8) |
| encode lz4, 50k entries | 21.3 (20.5 to 54.3) | 21.9 (20.8 to 45.6) |
| decode raw, 50k entries | 5.4 (5.3 to 9.3) | 14.6 (14.2 to 21.7) |
| decode lz4, 50k entries | 7.2 (6.9 to 12.5) | 8.4 (8.1 to 13.4) |
| merge 4x20k lz4 runs into 256 KiB runs | 34.4 (34.1 to 60.0) | 36.4 (35.8 to 63.3) |
| LZ4 decompress, 1376 blocks | 2.3 to 2.8 | 1.2 to 1.5 |

On the same ABI, Rust's core is faster where there is no LZ4 work: its
sort and its record writer beat the Zig port's. Zig's hand-written LZ4
decoder is about 1.8x faster than lz4_flex, which is why the LZ4 rows tie.
These are inferences from the rows, not from a profile.

## Size

| | raw bytes | gzip -9 | brotli 11 |
|---|---:|---:|---:|
| Rust before (wasm-bindgen, plus 21 kB JS glue) | 73,502 | 35,830 | 31,400 |
| Rust flat ABI, nightly std, talc, wasm-opt | 33,154 | 21,336 | 19,108 |
| Rust flat ABI, stable toolchain | 40,833 | 24,622 | not measured |
| Zig ReleaseSmall, zero-alloc | 23,975 | 10,506 | 9,415 |

kv "after open" brotli went from 64.6 kB to 49.1 kB with the Rust flat
ABI (`pnpm bench:size`). Zig would take it to about 40 kB. The remaining
Rust gap to Zig is mostly 8 kB of CRC tables in engine-core and std's
sort.

## What zero allocation costs

The Zig module reserves its whole slab in `init`. Measured with
`peak_bytes`: an encode peaks at 2.75x its input bytes, a merge at about
10x its compressed input, because every input run is decoded into the
arena at once. A 73 MB flush needs 200 MiB; a merge of 40 MiB of LZ4 runs
about 400 MiB. The loader reserves 1 GiB per SharedWorker. Pages are
committed lazily by the OS, so untouched slab is cheap, but the
reservation is real and an operation past it fails with a capacity error
instead of growing. Rust's dynamic allocator grows to what the operation
needs, 36 MB for the harness, and never refuses.

## Robustness

Rust's engine-core passed the kv differential fuzz suites from the start.
The Zig port trapped on two classes of hostile input until fixed in this
round: additive bounds checks that wrap on wasm32, and an unbounded LZ4
size field. After the fixes it passes 294 of 295 kv tests; the remaining
one asserts that an oversized LZ4 size traps, which Zig now rejects with
a status. `ReleaseSmall` has no runtime bounds checks, so any check the
fuzzers have not reached is a trap inside the sandbox rather than an
error. Rust's safe code turns the same mistake into a panic with the same
trap, but its checked indexing is the default rather than a discipline.

## Not measured

Zig `ReleaseSafe` size and speed. Compiling the reference `lz4.c` with
Zig's clang. Real memory committed by a 1 GiB slab in Chrome over a long
session. Browser support for wasm SIMD, which neither build uses.
