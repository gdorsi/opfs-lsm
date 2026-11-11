# Coalescing cold page reads

Date: 2026-11-11. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement. The strategy comparisons alternate their variants inside one run,
which cancels that noise. The before and after of the bench suite alternates whole runs.

Status: implemented for run files opened through OPFS.

## Question

docstore `getMany` of 3,000 random ids, first read after a load, was 0.72× of Dexie in the bench
suite (issue 139). A trace showed the tab in `file.slice().arrayBuffer()` under the page cache,
with about 830 IPC messages on its main thread. Is the count of reads the cost, and what is the
cheapest way to cut it?

## One read per page is the cost

A probe dropped every cached page, switched the read strategy, and timed one `getMany`, in
rotation, 12 rounds per run. The store is `table/todos` at size `small`: 100,000 rows, 14.4 MB
in about 450 pages of 32 KB.

| strategy | median | reads |
|---|---:|---:|
| one read per page (as before) | 38.8 to 40.7 ms | 444 to 449 |
| neighbouring pages in one read | 12.6 to 14.6 ms | 5 to 8 |

Three runs, the range is over their medians. 3,000 random ids touch nearly every page, so the
second row reads the same bytes in a handful of requests.

## Choices

**Contiguous spans, not a composed Blob.** `new Blob([slice, slice, …]).arrayBuffer()` reads
scattered ranges in one request without the bytes between them. It is slower than one read per
page: 89 to 100 ms against 74 to 79 ms in the same run (7 reads against 446).

**Read through gaps up to 128 KiB.** With a copy per page (below), by ids per `getMany`:

| ids | per page | gap 0 | gap 64 KiB | gap 256 KiB | gap 1 MiB |
|---:|---:|---:|---:|---:|---:|
| 3,000 | 82 to 87 ms | 20 to 22 | 27 | 18 to 20 | 20 to 23 |
| 300 | 37 to 42 ms | 23 | 10 to 13 | 10 to 12 | 13 to 15 |
| 100 | 18 to 19 ms | 15 | 12 to 13 | 8 to 9 | 7 to 11 |
| 30 | 5.0 to 6.5 ms | 4.6 to 5.3 | 4.0 to 4.7 | 3.7 to 5.3 | 4.6 to 7.3 |
| 5 | 1.2 to 1.8 ms | 1.2 to 1.5 | 1.2 to 1.5 | 1.1 to 1.5 | 1.6 to 2.0 |

Two runs, 9 rounds each. This session was slower overall than the one above, so compare within
a row. One read costs about as much as 128 to 256 KiB of extra bytes. A 1 MiB gap starts to
lose on small batches. 128 KiB is the low end of the break-even, which wastes the fewest bytes.

**Spans of at most 1 MiB.** A 1 MiB cap gave 18 reads for the 3,000-id case and the same time
as 4 MiB and 16 MiB (21 ms against 22 to 27 ms).

**A copy per page.** Views into one span buffer are about 2 to 4 ms faster on 14.4 MB, but the
page cache charges each page its own bytes and evicts page by page. A view keeps the whole
span alive, so an evicted page would free nothing. While a span lands, its bytes exist twice.

**A batch is every read issued before the microtask queue goes quiet** (two turns with no new
read). When the run's metadata is cold as well, the gets all wake on the same promise and reach
their page read a turn or two apart. With that rule the cold-metadata case made 13 reads, with
one read per page 454.

## Before and after

`table/todos`, `kv/fillrandom` and `yjs/many-docs`, ours only, size `small`. Four rounds
alternating `main` and the change, 3 reps each, so 12 runs a side. Median ops/s and range.

| phase | main | change | |
|---|---:|---:|---|
| `table/todos` get-bulk | 40.4k (29.1k–53.1k) | 139k (118k–162k) | ×3.44, ranges apart |
| `table/todos` get-serial | 198k | 198k | same |
| `table/todos` where-owner | 49 | 52 | ranges overlap |
| `table/todos` page-created | 1,692 | 1,467 | ranges overlap |
| `table/todos` coldopen | 515 | 484 | ranges overlap |
| `kv/fillrandom` readrandom | 496k | 526k | ranges overlap |
| `kv/fillrandom` readrandom-unsettled | 259k (151k–303k) | 174k (121k–264k) | see below |
| `yjs/many-docs` load | 8,416 | 9,195 | ranges overlap |

`readrandom-unsettled` looked 33% slower. It is not the change. Each read in that phase is
alone in its batch, so the phase was rerun with the two paths alternated read by read:

| run | lone reads | direct p50 | through the coalescer p50 |
|---|---:|---:|---:|
| 1 | 643 | 465 µs | 445 µs |
| 2 | 398 | 370 µs | 390 µs |
| 3 | 659 | 350 µs | 355 µs |

The phase makes 400 to 660 cold reads of about 400 µs each while the host ingests, and how many
it makes varies from run to run. That count, not the read path, moves its number.

Dexie's get-bulk was 98.6k ops/s in the clean run of issue 139, where docstore was 70.5k.

## Not measured

- Firefox and Safari.
- Range scans. A cursor awaits each page before it asks for the next, so its reads are alone
  in their batches and take the old path.
- The peak of the extra memory while spans land.
