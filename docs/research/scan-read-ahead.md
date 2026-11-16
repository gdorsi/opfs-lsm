# Reading ahead in scans

Date: 2026-11-16. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, with a load average of 4 to 18. Each comparison is 5 interleaved runs per
contender, and before and after are separate sessions of the same selection.

Status: implemented.

## Question

The home page showed "Reopen the board" at 0.75× of y-indexeddb (106 ms against 79.3 ms). The
step is the `cold-open` phase of `yjs/whiteboard-session`: a new tab after every SharedWorker has
exited opens kv, then the workspace doc, then the board doc. Opening the board reads every stored
Yjs update in one range scan and applies them in one Yjs transaction. y-indexeddb does the same
work with one `getAll`. How much of the gap is kv reading the data?

## Where the time goes

At size `small` (1,000 shapes), both stores block the main thread for one task of about 70 ms:
Yjs applying the updates. What is left of opening the board, mostly the read before that task,
was 13.7 ms on kv against 5.7 ms on y-indexeddb (medians of 5 runs).

At size `large` (5,000 shapes, 2.8 MB of runs on disk) the read was 32.6 ms on kv against
16.5 ms. A CPU profile of the phase showed the tab idle for about 28 ms during the scan, in short
gaps between about 17 ms of scan work. The scan read each run one 32 KB page at a time and
awaited each page before asking for the next: about 90 round trips to the browser process in
sequence.

## What was measured

Opening the board minus its longest task, ms, median and range of 5 runs:

| size | kv before | kv after | y-indexeddb |
|---|---:|---:|---:|
| small | 13.7 (11 to 15) | 4.8 (4 to 5) | 5.7 (5 to 37) |
| large | 32.6 (28 to 50) | 15.6 (15 to 18) | 16.5 (14 to 19) |

The y-indexeddb column is from the before session. The ranges before and after do not overlap
at either size.

The whole `cold-open` phase, ms:

| size | kv before | y-indexeddb | kv after | y-indexeddb |
|---|---:|---:|---:|---:|
| small | 93.5 (86.5 to 119) | 79.4 (72.1 to 214) | 87.8 (82.2 to 103) | 77.5 (72.2 to 95.6) |
| large | 131 (126 to 157) | 108 (102 to 185) | 111 (107 to 121) | 182 (114 to 203) |

The phase is mostly Yjs, and its spread is wider than the change, so by the harness's rule
(non-overlapping min to max) the phase shows no measurable difference. In the after session at
`large`, y-indexeddb's longest task, Yjs applying the same updates, ranged from 91 to 165 ms, so
that column does not show kv ahead.

Other scans, ops/s:

| workload | kv before | kv after | IndexedDB |
|---|---:|---:|---:|
| `kv/fillseq` readseq, a full ordered scan | 610k (461k to 691k) | 967k (889k to 1,100k) | 572k to 593k |
| `kv/ycsb-e`, scans of 1 to 100 keys | 19.4k | 19.9k | 6.7k to 7.0k |
| `kv/fillseq` seeks of 10 and 100 keys | no measurable difference | | |
| `table/todos`, `tanstack-ondemand/queries` on kv | no measurable difference | | |

## LinearLite: the board and threads

The first `linearlite/browse` runs on docstore after the change showed the board phase at 61 to
109 ms against 43 to 45 ms before, and threads at 181 to 584 ms against 75 to 101 ms, in three
sessions that alternated before and after. Neither phase reads from disk: every page it needs is
already cached. A CPU profile from the cold open on put the time in TanStack DB's filters,
`evaluateLike` first: the search phase's queries.

TanStack DB drops a live query with no subscriber in an idle callback, with a 1 s timeout. The
search phase releases about 40 queries. Before the change, the jump phase after it waited on 245
small reads, the page went idle between them, and those queries were dropped during the jump.
With read-ahead the jump makes 29 larger reads and the main thread does not idle. At the end of
the jump the adapter still had 39 demands and 1,296 rows, against 7 demands and 700 rows before.
The board and threads paid for them: each new query filtered three times the rows, and each
eviction walked them against every demand.

A user pauses between screens, so the bench now starts each browse phase once the page is idle
([bench/README.md](../../bench/README.md)). With that wait, 3 runs each:

| step | before | after |
|---|---:|---:|
| `cold-open` phase | 157 ms (156 to 173) | 113 ms (109 to 122) |
| jump, p50 | 79.9 ms | 60.4 ms |
| board, p50 | 17.9 ms | 16.9 ms |
| thread fetched from the server, p50 | 2.11 ms | 2.24 ms |

The board and thread phases show no measurable difference. The two sessions ran at different
loads, 16 to 17.5 before and 11.8 to 12.8 after, so the cold open and jump rows lean on the
three alternating sessions above, which ran without the wait: their cold open took 113 to 142 ms
after against 146 to 242 ms before.

## Choices

**A window that doubles from one page.** A scan that stops early, as one with a `limit` does,
has asked for at most about twice as many pages past where it stopped as it read, and never more
than 32 (1 MiB, the largest span one read covers). A long cold scan reads its first page, then
2, 2, 3, 6, 12 and 24 pages at a time, then 16 pages (512 KiB) per read.

**Ask again only within half a window.** Topping the window up by one page per page entered sends
one read per page again once the window is full. Asking for a whole window at a time gives one
read per 16 pages: a cold scan of 99 pages takes under 20 reads, against 101 before.

**Nothing on the first page.** A scan that ends in its first page reads what a point get reads.

**The scan holds what it read ahead.** Looking each page up in the cache when the scan enters it
would count as reuse, and one pass would move every page it read into the main queue.

## What is left

- kv's open: 6.0 ms on a cold tab. y-indexeddb opens its database inside the workspace step, which
  takes 1.8 ms in all. See [open-path-round-trips.md](open-path-round-trips.md).
- Yjs replays every stored update, because the session never pauses for the 1 s merge.
- A deeper level opens its runs one at a time as a scan reaches them. Reading the next run's layout
  ahead is not done. The board's data is in L0, where every run is opened at the start.
- The TanStack DB adapter's eviction checks every held row against every demand, so its cost
  grows with both. Queries TanStack has not yet dropped keep their demands.
- `pages/type` reopen is Automerge's own load, 94 to 96 ms of about 130 ms at `small` and 1.2 s
  of 1.7 s at `large`. Both stores are level, and read-ahead does not move it.
