# Reading run files through a dedicated WebWorker

Status: rejected. A prototype cut one page read from about 160 µs to 20 µs, but only Chromium has
read-only sync access handles, opening a database with data got up to about 5 ms slower, and two
linearlite steps got slower. The prototype was dropped, and its code is not in the repository.
A later probe read the same handles through a SharedArrayBuffer
([sab-sync-read.md](sab-sync-read.md)).

Date: 2026-11-15. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, including another bench session. Every comparison alternates its
paths inside one run, which cancels most of that noise.

## Question

A tab reads each page of a run file with the async API: `file.slice().arrayBuffer()` on the main
thread. Each read is a round trip to the browser process. A dedicated WebWorker can instead open
a sync access handle, an OPFS file handle with blocking `read` and `write` calls. In Chrome it
can open one with `mode: "read-only"`, and several of those can be open on one file at once. Do
apps get faster if tabs read run files through one?

## The design tried

Each tab got one dedicated WebWorker that owned all of the tab's open run files. The page cache,
block decoding and merges stayed on the tab's main thread, and the SharedWorker host wrote as
before. To open a run, the dedicated WebWorker took the shared run lock (design.md, "Loading a
generation under churn"), called `createSyncAccessHandle({ mode: "read-only" })` and returned the
file size. A read was `handle.read(buffer, { at })` into a new buffer, transferred to the main
thread. A close closed the handle, then released the lock. The prototype replaced the
[coalesced reads](coalesced-page-reads.md) and sent replies two ways: one message per page, or
batched, one message for the reads issued before the microtask queue was quiet for two turns.

## What Chrome allows while a read-only handle is open

Probe in Chrome 157. A dedicated WebWorker holds a read-only handle on a file, and other
contexts try the following.

| Operation | Result |
|---|---|
| A second read-only handle, from another dedicated WebWorker | works |
| A readwrite sync access handle | `NoModificationAllowedError` |
| `createWritable()` | `NoModificationAllowedError` |
| `removeEntry()` | `NoModificationAllowedError`. Works once the handle is closed |
| `getFile()` from the main thread or a SharedWorker | works |
| `createSyncAccessHandle` in a SharedWorker | not defined |
| `new Worker()` in a SharedWorker | not defined |

- **The handle has to close before the lock is released.** Otherwise the host can see the run
  as free and fail to remove it.
- **Only a tab can use this.** A SharedWorker can neither open a sync access handle nor start a
  dedicated WebWorker.
- **It works only in Chromium.** [MDN's compatibility data](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle#browser_compatibility)
  lists the `mode` option from Chrome 121 and no Firefox or Safari version, and marks it
  experimental and not on the standards track. Chrome announced it in
  [New dev trial for multiple readers and writers](https://developer.chrome.com/blog/new-dev-trial-for-multiple-readers-and-writers).
  We inferred, but did not test, that other browsers ignore the unknown `mode` member and open
  an exclusive handle, so a second tab could not open the same run. A feature check is
  `"mode" in FileSystemSyncAccessHandle.prototype`, run in the dedicated WebWorker.

## Probe: one read costs 160 µs today and about 20 µs through a dedicated WebWorker

A 16 MiB file with 32 KiB pages. Three fresh Chrome launches of 8 rounds each, with the paths
alternated inside each round. One read at a time, 512 reads per path in each launch. Each cell
is the range of the three launches' percentiles.

| Path | p50 | p90 |
|---|---:|---:|
| Async API on the main thread (today) | 160 µs | 215–265 µs |
| Sync read in a dedicated WebWorker, round trip from the main thread | 15–20 µs | 25–45 µs |
| Async API in a dedicated WebWorker, round trip from the main thread | 170–175 µs | 205–260 µs |
| Message round trip alone | 10 µs | 15 µs |
| Sync read alone, inside the dedicated WebWorker | 5 µs | 10 µs |

- **The async API costs about 155 µs wherever it runs.** Moving it into a dedicated WebWorker
  saves nothing. The gain comes from the sync read.
- **With sync reads, merging pages saves nothing.** For 450 random pages requested at once,
  today's coalesced path took 9.32 ms (7.63–17.4), and the dedicated WebWorker took 3.98 ms
  (3.60–10.8) with one message per page, 4.99 ms (4.03–13.0) with one per batch and 4.75 ms
  (3.59–11.7) with one per span. Medians over 24 rounds, ranges overlapping.
- **Opening a file costs twice as much.** 64 small files opened one after another took 153 µs
  (131–238) a file today and 315 µs (253–876) through the dedicated WebWorker. Closing took 5 µs
  against 109 µs.

## Engine benchmarks: the time saved is the read time removed

kv workloads at size `small`: 100,000 entries, 11.6 MB, one message per page, 10 runs a side,
interleaved. "Apart" means the two min–max ranges do not overlap, the bench's rule for calling a
difference. Median wall ms and range:

| Workload, phase | Today | Dedicated WebWorker | |
|---|---:|---:|---|
| `fillrandom` readrandom-unsettled | 349 (320–406) | 252 (231–281) | −28%, apart |
| `fillseq` readseq | 178 (152–244) | 101 (92–116) | −43%, apart |
| `ycsb-c` | 254 (237–288) | 197 (189–247) | −22%, overlap |
| `ycsb-e` | 517 (490–622) | 467 (431–522) | −10%, overlap |
| `fillrandom` coldopen | 8.2 (6.5–12.2) | 9.0 (6.9–14.0) | +10%, overlap |

- **The slow tail shrinks the most.** The p99.9 of a get in readrandom-unsettled fell from
  296 µs to 45 µs, and that of a read in ycsb-c from 212 µs to 45 µs.
- **Each phase saves about the read time it removes.** A second run timed every run-file read.
  Wall time saved against read time removed: 70 and 66 ms in readrandom, 112 and 121 in
  readrandom-unsettled, 69 and 68 in readseq, 61 and 57 in ycsb-c.
- **After the change, reads are 5% to 21% of a phase.** The rest is engine work on the main
  thread, so the read path has little left to give.

## App benchmarks

The app families at size `small`, one message per page. 5 runs per side, interleaved, 130 runs
in all, none failed, every read checked. The linearlite, pages, whiteboard, table and fate
workloads have since left the bench.

- **Seven of 27 steps were faster with ranges apart,** by 18% to 32%, and by 58% for the time
  until linearlite's list total was right (92.7 to 38.5 ms). They were cold opens, sorting, paged
  queries and a trace load: `linearlite/browse` cold-open and sort, `tanstack/todos` coldopen,
  `tanstack-ondemand/queries` query-page, `table/todos` page-created and `yjs/trace` load.
- **Only linearlite filter and jump were slower with ranges apart,** 316 to 385 ms and 338 to
  516 ms. See below.
- **Other cold loads did not move,** such as Automerge, fate and `yjs/many-docs`. We inferred that
  main-thread engine and app work limits them, as in the engine benchmarks.
- **Opening a database that has data was slower in all 13 workloads that time it.** Ranges were
  apart in 6 of 13, by 2.4 to 4.8 ms, for example `fate/read-cache` 7.59 ms against 12.4 ms. We
  inferred that the extra time is the dedicated WebWorker starting up, plus about 0.16 ms more per
  run file to open. Neither was measured on its own.

## The linearlite filter and jump slowdown

The two slower steps read the same pages and show the same rows on both paths. They get slower
only when the next interaction starts right after the last one. Back to back, as the workload was
written, 5 runs per path. With 1 s idle after each interaction, 4 runs per path. Median ms and
range:

| Step | Back to back: today | One message per page | Batched | 1 s idle: today | One message per page |
|---|---:|---:|---:|---:|---:|
| cold-open | 185 (162–241) | 98.1 (88.7–112) | 105 (96.2–120) | 169 (134–508) | 98.2 (90.2–110) |
| sort | 93.4 (73.8–114) | 83.1 (52.7–95.9) | 91.7 (72.2–127) | 113 (76.0–137) | 72.7 (56.6–107) |
| filter | 301 (292–372) | 409 (322–459) | 291 (253–300) | 313 (284–336) | 273 (257–294) |
| search | 432 (318–529) | 442 (322–637) | 517 (428–562) | 419 (359–547) | 409 (362–537) |
| jump | 358 (297–387) | 559 (520–632) | 411 (351–662) | 323 (267–373) | 233 (224–245) |

- **With a second of idle, the dedicated WebWorker has the lower median on every step except
  search, which is even.** Cold-open and jump are apart: jump goes from 323 to 233 ms.
- **Batched replies remove most of the slowdown back to back.** Filter matches today. Jump is
  15% slower instead of 56%, and its range still overlaps today's.

Our reading, inferred and not confirmed with a trace: with one message per page, each page
lands in its own task. Work started by one interaction is still running when the bench counts
its view as shown, so its cost lands in the next step. That also flatters the step that started
the work, so the back-to-back gains on cold-open and sort may be overstated.

## What adopting it would take

- A feature check, with today's path kept as the fallback for Firefox and Safari. That means
  two read paths to maintain.
- Batched replies.
- Closing the handle before releasing the run lock.
- Up to about 5 ms more to open a database that has data. Starting the dedicated WebWorker with
  the page may hide part of it. Not measured.

## Not measured

- Firefox and Safari, where the option is not supported, and Chrome on Android.
- Two tabs reading the same run at once.
- Sizes above `small`.
- Memory use of the dedicated WebWorker.
- Batched replies across all app families. Only linearlite browse ran with them.
