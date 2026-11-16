# Reading ahead in scans

Date: 2026-11-16. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, with a load average of 4 to 7. Each comparison is 5 interleaved runs per
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
| small | 13.7 (11 to 15) | 4.8 (4 to 5) | 5.5 (4 to 6) |
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

## Choices

**A window that doubles from one page.** A scan that stops early, as one with a `limit` does,
reads at most as many pages past its end as it read before. A long scan reaches 32-page reads
(1 MiB, the largest span one read covers) within about 20 pages.

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
- `pages/type` reopen is Automerge's own load, 94 to 96 ms of about 130 ms at `small` and 1.2 s
  of 1.7 s at `large`. Both stores are level, and read-ahead does not move it.
