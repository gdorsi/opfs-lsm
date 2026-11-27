# Scan bounds inside a block

Status: shipped. [design.md, "Reads"](../design.md#reads) describes how a scan finds its bounds in a
block and how a `reverse` scan reads one.

Date: 2026-11-27. Chrome 158 headless and Node 26.13.1, macOS arm64, Apple M2 Pro, base commit
`6f83cdeb`. Other sessions used the machine: the load average was 2 to 9 during the Chrome runs
and up to 19 during the Node runs. Every comparison alternates the two builds, so both saw the
same load.

## Question

A warm read of an index range is JavaScript on the tab's main thread, with nothing to wait for.
Does a scan do work inside a block that its answer does not need?

## Where the time went

A Node harness replayed the `small` tracker history through the docstore contender on the memory
fs with `fake-indexeddb`, checked every goal's answer against the oracle, and then timed each
goal warm, 300 calls a round. A CPU profile of those calls showed two costs that grow with the
block and not with the answer:

- **A reverse scan walked the whole block forward.** To step back through records of varying
  length, it first read every record below its end bound to learn where each starts, then read
  each one again on the way back. A list that takes 50 rows from the newest end paid for the
  several hundred entries of each 32 KiB block it entered. Reading a record was 15% to 19% of the
  label list, the deep window and the emptied column.
- **A scan compared every entry of its last block with its end bound.** A count over an index
  prefix sits inside one block, so it paid one key compare per entry it counted. That compare was
  19% of the status counts.

## What changed

A block's offset table samples every fourth record. A reverse scan now starts at the last
sampled group below its bound and steps back one group at a time, and reads each record once. A
scan finds its end bound with one search of the block, as it finds its start, and compares no
entry with it.

## Results

The Node harness, median µs a call of 5 alternated runs a side. The second column pair is the
second change measured on top of the first.

| goal | base | reverse by group | | then one search for the end |
|---|---:|---:|---|---:|
| `myIssues` | 192.3 | 162.4 | | 160.9 |
| `labelPage` | 305.2 | 260.3 | | 255.1 |
| `deepWindow` | 272.0 | 237.9 | | 230.2 |
| `drainedPage` | 275.0 | 257.2 | | 241.8 |
| `statusCounts` | 60.7 | 65.7 | | 57.9 |

The ranges of `myIssues`, `labelPage` and `deepWindow` do not overlap between base and the first
change. `statusCounts` is a forward scan, so the first change does not touch it. For the second
change its ranges overlap in each run, and three separate comparisons gave 11%, 23% and 16%
less time. `drainedPage` has two states in this harness, 100 µs and 280 µs, by whether the host
flushed the sprint close before the goal ran, so its row is weak evidence.

Chrome, `tracker/goals` at size `small` on the docstore contender, 6 runs a side, one run a turn:

```sh
node bench/cli.ts run tracker/goals --contenders docstore --reps 1   # once per build, in turn
node bench/cli.ts compare base.jsonl new.jsonl
```

| metric | base | both changes | rank-sum, 5% level |
|---|---:|---:|---|
| `deepWindow` warm | 0.404 ms | 0.359 ms | 1.12× faster |
| `recentActivity` warm | 0.613 ms | 0.533 ms | 1.15× faster |
| `labelPage` warm | 0.463 ms | 0.416 ms | not separated |
| `myIssues` warm | 0.360 ms | 0.328 ms | not separated |
| `statusCounts` warm | 0.169 ms | 0.165 ms | not separated |

Of 191 series, the other 189 show no measurable difference, the writes and every cold read among
them. A warm sample in the bench is one of 3 calls after the first, so the code runs before the
optimizing compiler has it, and the gain is smaller than in a loop of 300 calls. A cold read
waits for OPFS for milliseconds and does not see a change of microseconds.

kv at import went from 19,764 to 19,774 gzip bytes, and from 36,363 to 36,284 brotli bytes after
open, measured with Node 24.

## Not done

- **The tables of [benchmarks.md](../benchmarks.md) were not republished.** They are from an
  Apple M5 Max, and a run from this machine would move every cell by more than the change does.
- **A search of the block that skips the bytes its bounds share**, as the memtable's search does.
  Comparing a key with a record was 6% of the warm goals after both changes. kv had 26 gzip bytes
  left under its import budget.
- **The emptied column.** Its scan passes about 1,000 tombstones, each compared with the put it
  hides in an older source. The merge was not changed.
