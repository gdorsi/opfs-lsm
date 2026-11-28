# Cold gets that wait for the Bloom filter

Status: rejected. No code changed. A cold get still reads its block of every level whose Bloom
filter is not resident, as [design.md, "Reads"](../design.md#reads) describes.

Date: 2026-11-28. Chrome 158 headless and Node 26.13.1, macOS arm64, Apple M2 Pro, base commit
`0a8ceece`. Other sessions used the machine: the load average was 2.0 to 3.9 during the Chrome
runs. The two builds alternated, one run a turn, so both saw the same load.

## Question

A `getMany` in a fresh tab finds no Bloom filter resident, so it reads the key's block in every
level at once, and only one of those levels holds the key. In Chrome, reads issued together
share the bandwidth: 13 reads of 128 KiB took 5.2 to 5.7 ms against 0.6 ms for one
([cold-read-run-metadata.md](cold-read-run-metadata.md)). Would a get that waits for the filter,
once guessing has cost more bytes than the filter, make the cold goals faster?

## What was tried

Each run counted the bytes of the blocks gets read before its filter was resident. While that
count stayed at or below the bytes of the run's filter, a get read its block as before. Past it,
a get waited for the filter, then read only the blocks the filter let through. A failed filter
read let gets guess again. The first get of a run always guessed, so a single cold `get` read as
before.

It cost 65 gzip bytes of kv at import, 33 bytes over the 19,800 budget.

## Results

A Node harness replayed the `small` tracker history through the docstore contender on the memory
fs, opened a second handle as a fresh tab, and delayed every file read by 0.3 ms and every open
by 0.5 ms. Bytes read by the first call of each goal, one run each:

| goal | base | filter budget |
|---|---:|---:|
| `deepWindow` | 1,890 KiB, 61 reads | 1,603 KiB, 52 reads |
| `triagePage` | 3,030 KiB, 96 reads | 2,750 KiB, 88 reads |
| `labelPage` | 1,837 KiB, 59 reads | 1,640 KiB, 53 reads |
| `search` | 900 KiB, 30 reads | 725 KiB, 24 reads |

The reads that remained were one 32 KiB block per scattered document. Some calls took one more
dependent round of reads, since a get past the budget waits for the filter and then for its block.

Chrome, `tracker/goals` at size `small` on the docstore contender, 4 runs a side:

```sh
node bench/cli.ts run tracker/goals --contenders docstore --reps 1   # once per build, in turn
node bench/cli.ts compare base.jsonl budget.jsonl --all
```

| metric | base | filter budget | rank-sum, 5% level |
|---|---:|---:|---|
| `deepWindow` cold | 11.3 ms | 12.7 ms | 1.13× slower |
| `triagePage` cold | 13.9 ms | 15.1 ms | not separated |
| `labelPage` cold | 10.9 ms | 12.1 ms | not separated |
| `search` cold | 8.86 ms | 9.32 ms | not separated |
| store open in a fresh tab | 21.0 to 22.2 ms | 24.7 to 27.0 ms | 1.15× to 1.26× slower on 9 of 15 phases |

Chance alone would mark about 6 of the 125 series the test can separate. The open got slower on
every phase's median. No cold goal got faster on its median by more than 0.4 ms. Saving 10% to
20% of the bytes did not pay for the round a get spent waiting for the filter.

## Not done

- **Smaller reads for a point get.** A scattered document still costs one 32 KiB block. A get
  needs the block's prefix, its offset table and one group of records, which sit at both ends of
  the block, so reading less would take two dependent reads or a new block format.
- **A threshold on the keys of one `getMany`.** The budget per run already let the small joins
  of a card list guess. The Chrome result says the wait itself is the cost, so no threshold was
  measured.
