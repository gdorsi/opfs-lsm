# Cold gets that wait for the Bloom filter

Status: rejected. No code changed. A cold get reads its block of every level it reaches before
one whose Bloom filter is resident, as [design.md, "Reads"](../design.md#reads) describes.

Date: 2026-11-28. Chrome 158 headless and Node 26.13.1, macOS arm64, Apple M2 Pro, base commit
`0a8ceece`. Other sessions used the machine: the load average was 2.1 to 3.5 during the Chrome
runs. The two builds alternated, one run a turn, so both saw the same load.

## Question

On that commit, a `getMany` in a fresh tab found no Bloom filter resident, so it read the key's
block in every level whose range held the key, at once, and at most the newest of them answered.
In Chrome, reads issued together share the bandwidth: 13 reads of 128 KiB issued together each
took 5.2 to 5.7 ms to resolve, against 0.6 ms for one alone
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
| `triagePage` phase wall | 69.6 ms | 73.4 ms | 1.05× slower |
| `labelPage` phase wall | 61.2 ms | 66.8 ms | 1.09× slower |
| `search` phase wall | 49.5 ms | 53.6 ms | 1.08× slower |
| store open in a fresh tab | 21.0 to 22.2 ms | 24.7 to 27.0 ms | 1.15× to 1.26× slower on 9 of the 14 phases after `replay` |

The test marked 22 of 191 series, where chance alone would mark about 6 of the 125 it can
separate. No cold goal got faster on its median by more than 0.4 ms. Saving 9% to 19% of the
bytes did not pay for the round a get spent waiting for the filter.

The open is not explained by the change. Opening the store made one `get`, of the catalog, and
the first get of a run guessed as before. Each side was a copy of its build's `dist`, swapped
before each run, and both recorded the commit as dirty. The verdict rests on the cold goals and
their phase walls, not on the open.

## Not done

- **Smaller reads for a point get.** A scattered document cost one 32 KiB block. A get needed
  the block's prefix, its offset table and one group of records, which sat at both ends of the
  block, so reading less would have taken two dependent reads or a new block format.
- **A threshold on the keys of one `getMany`.** The budget per run already let the small joins
  of a card list guess. The Chrome result says the wait itself is the cost, so no threshold was
  measured.
