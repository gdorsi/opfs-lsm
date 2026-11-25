# What a fresh tab's first query waits for

Status: shipped. Blocks are 32 KiB, the manifest file holds each run's block index, and a `get`
does not wait for a Bloom filter ([Reading a run](../design.md#reading-a-run),
[Manifest format](../design.md#manifest-format)). Rejected: reading every run's tail at open, and
keeping the block indexes in the manifest copy in IndexedDB.

Date: 2026-11-24 and 2026-11-25. Chrome 157 headless, macOS arm64, Apple M5 Max. The probe ran
at `d5957988`. The comparisons are `06743177` (before) against the branch of PR 445, variants
alternated inside one session. A bench run is
`node bench/cli.ts run tracker/goals --size <size> --contenders tracker/docstore --reps <n> --seed <s>`,
and two files are compared with `node bench/cli.ts compare`. The tables are medians in ms.

## Question

At 20,000 issues the tracker goal `issueThread`, an issue with its comments, took 5.90 ms on
docstore in a fresh tab, against 1.89 ms on Dexie and 4.29 ms on SQLite. The same call took
0.08 ms warm, where docstore was the fastest of the three. What does the first call wait for?

## The goal is small

The goal picks issues at the 90th percentile of comments per issue: 4 comments at 20,000 issues
and 5 at 200,000 (seed 1, median 2). An issue is 490 bytes of JSON on average and a comment 236.
An answer is about 12 rows and under 2 KB: the issue, its comments, their authors' names, the
project key, and at most one assignee and three labels. Ids are random, so the comments of one
issue are not neighbours in any of the three stores. The goal measures a fixed cost per lookup.

## What the call did

A recorder wrapped the page's file and IndexedDB calls, 5 cold calls per store on 5 issues.

docstore, 5.4 to 8.3 ms under the recorder:

- **Waiting on OPFS reads: 3.0 to 6.0 ms, median 3.7.** The call made 16 to 18 reads for about
  1 MiB, in 7 to 8 waves. A wave is a set of reads issued together, and a read that depends on
  an earlier answer starts a new one.
- **Main thread with no read in flight: 2.3 to 2.9 ms.** The same call on another issue in the
  same tab spent 0.2 to 0.45 ms there.
- **5 to 7 of the reads were run tails, 640 to 896 KiB.** A tab read a run's Bloom filter and
  block index, 128 KiB from the end of the file, before it could locate a page of that run. The
  other 9 to 10 reads were pages of 32 KiB.
- **The call opened no file.** The opens ran inside `openDb`, 14 runs in parallel in about 3.4 ms.

The 14 runs held 44 MB and 1.27 MB of metadata: 913 KB of block index, which stored the first and
the last key of every 4 KiB block, and 359 KB of Bloom filters.

Dexie, 1.95 to 2.25 ms, sent 9 to 11 requests in one transaction, in 4 dependent rounds:

| Round | Requests | Cold | Another issue, same tab |
|---|---|---:|---:|
| Before the first request | none | 0.56 | 0.06 |
| Project by key | 1 | 0.12 | 0.05 |
| Issue by project and number | 1 | 0.46 | 0.12 |
| Assignee, labels, project key, comments | 3 to 4 together | 0.65 | 0.22 |
| Authors | 4 together | 0.08 | 0.07 |

A request on an index returned the row, and one request returned the four comments. The backing
store is in the browser process and was opened by `open`, so the tab loaded nothing but answers.
That it reads its files with no wait of its own is inferred from the request times, not measured.

SQLite posted both statements at once, and its worker ran the join next to the file: 2 messages.
Its next issue took 0.32 ms, so the 4.29 ms was a cost of the first query.

## Rejected: read every run's tail at open

A prototype read each run's Bloom filter and block index while the files opened. 5 alternating
runs a side at 20,000 issues, range in brackets:

| Goal | Cold, before | Cold, tails at open | Open, before | Open, tails at open |
|---|---:|---:|---:|---:|
| Issue with its comments | 6.11 (6.02 to 6.55) | 3.33 (3.09 to 4.83) | 19.56 (19.34 to 20.18) | 22.12 (18.74 to 26.40) |
| Todo page | 4.12 (3.87 to 4.28) | 2.66 (2.49 to 2.91) | 19.08 (18.54 to 19.80) | 21.54 (19.23 to 26.41) |
| Triage page | 10.00 (9.96 to 10.09) | 7.54 (7.27 to 7.65) | 19.55 (19.31 to 19.74) | 21.33 (19.48 to 23.24) |

The cold call got 1.5 to 2.8 ms faster and open got slower by about as much. Open plus cold showed
no measurable difference: 25.85 against 25.25 ms on the issue goal. Thirteen reads of 128 KiB
issued together each took 5.2 to 5.7 ms to resolve, against about 0.6 ms for one alone. The same
verdict as [open-path-round-trips.md](open-path-round-trips.md) reached for one `get`. The
prototype gave the size of the prize: about 3 ms on this goal for a tab that holds the metadata
when `openDb` resolves.

## Shipped: the block index travels with the manifest

A block of 32 KiB made the block index short enough to read at open: one entry per block the tab
reads, where the index had eight. With the block size alone changed, the files stayed the same
size, writes showed no measurable difference, and warm point reads stayed within 10% (3 runs a
side).

5 alternating runs a side per seed at 20,000 issues, cold:

| Goal | Seed 1 | Seed 2 | Seed 3 |
|---|---|---|---|
| Issue with its comments | 6.03 → 4.87 | 6.09 → 4.71 | 5.92 → 4.68 |
| Status page | 4.19 → 3.30 | 4.34 → 3.26 | 4.32 → 2.84 |
| My issues | 4.93 → 3.73 | 4.89 → 3.60 | 4.84 → 3.41 |
| Recent activity | 4.22 → 3.03 | 4.11 → 3.17 | 4.07 → 2.83 |
| `kv/fillrandom`, first `get` after open | 1.51 → 0.98 | 1.53 → 0.97 | 1.53 → 0.99 |

- 9 of 13 cold goals had ranges apart on every seed. `deepWindow`, `triagePage`, `labelPage` and
  `search` were faster on the median on every seed, with ranges apart on some.
- Open per goal was lower on the median on every goal and seed, with overlapping ranges.
- `ycsb-a` reads and updates and `fillrandom` writes overlapped on every seed.
- At 200,000 issues, 3 runs a side: open 23.0 to 24.9 → 23.2 to 24.2, and cold goals 11 to 33%
  faster with ranges apart on 12 of 13. Issue with its comments went from 6.61 to 4.43.

What it cost:

- **Stores with many index entries grew.** A block shares one key prefix, and 32 KiB of index
  entries share a shorter one. The tracker store was 2 to 4% larger at 20,000 issues, and the
  Space-Amp of the tiny tracker went from 3.21 to 3.34 to 3.36. kv files were 1% smaller.
- **The manifest file grew with the data**: 328 KB at 200,000 issues and 137 runs, against 16 KB.
  The host rewrites it on each flush and compaction. Flush and import times showed no
  measurable difference.

## Rejected: the block indexes in the manifest copy

The first two versions also kept the whole manifest in `meta.manifest`. At 200,000 issues open
got about 3 ms slower. Decoding the manifest twice was about 1 ms of it. The rest
went away only when the copy was back to its 16 KB. That record is written on every flush and
read by every tab before it opens a file, so it has to stay the size of the list of runs. What a
tab needs at open and that grows with the data went into the manifest file, which the tab reads
while the runs open. The regression did not show at 20,000 issues.

## What is left against Dexie

After the change docstore's cold issue with its comments was 4.49 ms in the published run of
2026-11-25 (Chrome 158), against 2.00 ms for Dexie and 4.61 ms for SQLite.

- **Dependent block reads.** An index entry and then its row are two reads from the tab, each a
  call out of the tab's thread. With the metadata resident the prototype's call still waited 1.1
  to 1.5 ms in 3 to 4 waves.
- **Code that runs for the first time.** About 1.7 ms of main thread in the prototype's cold call,
  against 0.08 ms for the whole call warm. The profile was flat: about 80 functions under 0.1 ms
  each. Dexie spent 0.56 ms before its first request, against 0.06 ms on the next issue.
- **Dexie cannot go below its four rounds.** Warm it took 0.33 ms, and docstore 0.074 ms.

## Not measured

- The reads and waves of a cold call after the change. The counts above are from before it.
- An index on comments that includes the body and the author, as the card indexes include a
  card's fields. A thread would then be one range read in place of a row read per comment.
- `kv/fillrandom` `coldopen`, the open itself: 8.05 → 9.94 ms with ranges apart on seed 1, and
  overlapping on seeds 2 and 3 (9.07 → 9.75, 9.39 → 9.12). Not explained.
- The 200,000-issue comparison used the build one step before the index decoder was shortened.
  The format and the behaviour were the same.
- Firefox and Safari.
