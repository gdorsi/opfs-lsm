# A 64 MiB page cache

Status: rejected. `cacheBytes` stays 256 MiB by default, as design.md, "Reading a run" states.

Date: 2026-11-23. Chrome 157 headless, macOS arm64, Apple M2 Pro, commit `69f68dd6`. Another
session ran on the machine during every measurement, with a load average of 3 to 14. Each side is
5 runs, interleaved one run at a time on the same build, so both sides saw the same noise.

## Question

`cacheBytes` caps the SST pages, Bloom filters and block indexes one tab keeps in memory. Can the
default drop from 256 MiB to 64 MiB, to save memory in web apps, without slowing reads?

## Where it can matter

A cache only changes anything when a tab's data is larger than the cache. At size `small`, the
largest kv store across the bench is 50.8 MiB on disk (`tracker/goals` on docstore), so a 64 MiB
cache never drops a page there and the published tables cannot move. The comparison runs at size
`large`, on the four workloads with the most data:

| workload | live MB | disk MB |
|---|---:|---:|
| `kv/fillrandom`, `kv/ycsb-a` | 116 | 119 |
| `kv/large-values` | 198 | 203 |
| `tracker/goals` (docstore) | 197 | 345 |

The engine has no eviction counter. That the smaller cache evicts rests on these sizes, and on the
harness confirming that kv opened with `cacheBytes` 67108864.

## What was measured

```sh
pnpm bench kv/fillrandom kv/ycsb-a kv/large-values tracker/goals --size large --reps 1 \
  --contenders kv,docstore [--cache-bytes 67108864]
node bench/cli.ts compare cache-256mib.jsonl cache-64mib.jsonl
```

Rows that `compare` marks as a difference, median and range of 5 runs:

| phase | 256 MiB | 64 MiB | change |
|---|---:|---:|---|
| `kv/fillrandom` readrandom | 375k ops/s (246k to 440k) | 4.5k ops/s (2.6k to 9.7k) | 83× slower |
| `kv/fillrandom` readrandom-cold | 53k ops/s (34k to 69k) | 6.4k ops/s (4.5k to 9.8k) | 8× slower |
| `kv/fillrandom` readrandom-unsettled | 22.9k ops/s (18.4k to 32.4k) | 4.7k ops/s (2.1k to 8.4k) | 4.8× slower |
| `kv/fillrandom` readmissing | 1.22M ops/s (1.18M to 1.26M) | 348k ops/s (159k to 535k) | 3.5× slower |
| `kv/ycsb-a` ycsb-f | 8.4k ops/s (6.0k to 12.1k) | 3.7k ops/s (2.5k to 6.1k) | 2.2× slower |
| `kv/ycsb-a` ycsb-a, mean read | 0.022 ms | 0.118 ms | 5.3× slower |
| `kv/large-values` readscattered-cold | 16.0k ops/s (12.6k to 22.4k) | 9.4k ops/s (5.3k to 10.7k) | 1.7× slower |
| `kv/large-values` tab memory peak | 478 MB | 352 MB | 26% less |
| `kv/large-values` renderer peak | 578 MB | 493 MB | 15% less |
| `kv/fillrandom` renderer peak | 1955 MB | 1910 MB | 2% less |
| `tracker/goals` compaction bytes at settle | 4480 MB | 4573 MB | 2% more |

On every read phase above, the ranges do not overlap. The `tracker/goals` queries show no
difference, and 270 of the 302 series compared show none.

## Conclusion

Point reads over a store larger than the cache miss it and go back to OPFS, so random reads at
`large` slow down by 2× to 83×. The memory saved is 15% to 26% of a tab's peak on large values and
2% on small ones. That trade is worth less than read speed, so the default stays 256 MiB. An app
that needs less memory can pass a smaller `cacheBytes` itself.

Not measured: a size between 64 MiB and 256 MiB, such as 128 MiB, which holds the whole
`kv/fillrandom` store at `large`.

The raw runs, one record per run, are in git history, and
`git show df257487:docs/research/page-cache-size/cache-256mib.jsonl` and
`git show df257487:docs/research/page-cache-size/cache-64mib.jsonl` print them.
