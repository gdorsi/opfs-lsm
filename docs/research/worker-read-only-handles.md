# Reading run files through a dedicated WebWorker

Date: 2026-11-15. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, including another bench session. Every comparison alternates its
paths inside one run, which cancels most of that noise.

Status: not adopted. The prototype was dropped for now, and its code is not in the repo. This
note keeps the design and the numbers.

## Question

A tab reads each page of a run file with the async API: `file.slice().arrayBuffer()` on the main
thread. Each read is a round trip to the browser process. A dedicated WebWorker can instead open
a sync access handle, an OPFS file handle with blocking `read` and `write` calls. In Chrome it
can open one with `mode: "read-only"`, and several of those can be open on one file at once. Do
apps get faster if tabs read run files through one?

## The design tried

Each tab gets one dedicated WebWorker that owns all of the tab's open run files. Nothing else
moves. The page cache, block decoding and merges stay on the tab's main thread. The SharedWorker
host writes as before. Only the three file operations of a run change.

- **Open.** The dedicated WebWorker takes the shared Web Lock `opfs-lsm:<name>:run:<path>`. That
  is the lock a tab takes today (design.md, "Loading a generation under churn"). It then calls
  `createSyncAccessHandle({ mode: "read-only" })` and returns the file size. If the file is
  missing, it releases the lock and reports the file as missing, as today.
- **Read.** `handle.read(buffer, { at })` into a new buffer. The buffer is transferred to the
  main thread, not copied.
- **Close.** Close the handle, then release the lock. The order matters. While a read-only
  handle is open, Chrome refuses `removeEntry`, so the host's removal of an old run could fail.

A `get` whose page is in the page cache still posts no message. Only page loads do.

The prototype replaced kv's run-file open in the tab, so the read coalescing of
[coalesced-page-reads.md](coalesced-page-reads.md) did not run. It sent replies two ways:

- **One message per page.** Each page read is one request and one reply.
- **Batched.** The tab collects page reads until the microtask queue is quiet for two turns,
  which is the coalescer's rule. It sends them in one message and gets one reply with a buffer
  per page.

Below, "today" is the current path.

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
alternated inside each round.

**One read at a time.** 512 reads per path in each launch. Each cell is the range of the three
launches' percentiles.

| Path | p50 | p90 |
|---|---:|---:|
| Async API on the main thread (today) | 160 µs | 215–265 µs |
| Sync read in a dedicated WebWorker, round trip from the main thread | 15–20 µs | 25–45 µs |
| Async API in a dedicated WebWorker, round trip from the main thread | 170–175 µs | 205–260 µs |
| Message round trip alone | 10 µs | 15 µs |
| Sync read alone, inside the dedicated WebWorker | 5 µs | 10 µs |
| Async API alone, inside the dedicated WebWorker | 155–160 µs | 185–190 µs |

- **The async API costs about 155 µs wherever it runs.** Moving it into a dedicated WebWorker
  saves nothing. The gain comes from the sync read.
- Three more launches of 288 reads per path gave medians of 160 to 240 µs today and 15 to 25 µs
  through the dedicated WebWorker.
- Keeping the main thread busy for 50 to 500 µs between reads left the dedicated WebWorker at
  15 to 25 µs. Today's path went from 165–190 µs to 180–250 µs.

**Batches.** N distinct random pages requested at once. Median ms over the 24 rounds, with the
range.

| Pages | Today: main thread, coalesced | Main thread, one read per page | Dedicated WebWorker, one message per page | Dedicated WebWorker, one message per batch |
|---:|---:|---:|---:|---:|
| 5 | 0.80 (0.44–9.11) | 0.65 (0.39–2.66) | 0.10 (0.06–0.71) | 0.09 (0.05–0.32) |
| 30 | 2.04 (1.59–4.76) | 2.50 (1.96–6.41) | 0.30 (0.24–1.02) | 0.30 (0.22–0.87) |
| 100 | 3.88 (3.13–8.68) | 7.86 (6.70–19.4) | 0.89 (0.81–3.82) | 0.94 (0.83–2.53) |
| 450 | 9.32 (7.63–17.4) | 42.6 (32.9–67.1) | 3.98 (3.60–10.8) | 4.99 (4.03–13.0) |

Merging neighbouring pages into spans first, as kv does today, and sending one message per span
took 4.75 ms (3.59–11.7) for 450 pages. Neither spans nor one message per batch beat one message
per page, though the ranges overlap. With sync reads, merging pages saves nothing.

**Open and close.** 64 small files. Median and range over the 24 rounds.

| | Today | Dedicated WebWorker |
|---|---:|---:|
| Open the 64 one after another, per file | 153 µs (131–238) | 315 µs (253–876) |
| Close the 64 one after another, per file | 5 µs (4–6) | 109 µs (93–244) |
| Open all 64 at once | 2.5 ms (1.8–5.0) | 4.7 ms (3.5–8.7) |

## Engine benchmarks: the time saved is the read time removed

kv workloads at size `small`: 100,000 entries, 11.6 MB. The `kv-base` contender reads as today
and `kv-sync` reads through the dedicated WebWorker. Both open through the same harness on the
package's SharedWorker, so only the read path differs. One message per page. 10 runs each,
interleaved. "Apart" means the two min–max ranges do not overlap, the bench's rule for calling
a difference.

The phases:
- **readrandom-unsettled:** random gets while the SharedWorker is still compacting.
- **readrandom:** the same, after compaction has settled.
- **readseq:** one full forward scan.
- **seekrandom-100:** random seeks that read 100 keys each.
- **ycsb-c:** point reads, with some keys much hotter than others.
- **ycsb-e:** scans of 1 to 100 keys, with 5% inserts.
- **coldopen:** open in a fresh tab and get one key.

Median wall ms and range:

| Workload, phase | Today | Dedicated WebWorker | |
|---|---:|---:|---|
| `fillrandom` readrandom-unsettled | 349 (320–406) | 252 (231–281) | −28%, apart |
| `fillseq` readseq | 178 (152–244) | 101 (92–116) | −43%, apart |
| `ycsb-c` | 254 (237–288) | 197 (189–247) | −22%, overlap |
| `ycsb-e` | 517 (490–622) | 467 (431–522) | −10%, overlap |
| `fillrandom` readrandom | 173 (165–304) | 192 (178–216) | +11%, overlap, see below |
| `fillseq` seekrandom-100 | 852 (798–965) | 829 (777–891) | −3%, overlap |
| `fillrandom` coldopen | 8.2 (6.5–12.2) | 9.0 (6.9–14.0) | +10%, overlap |

- **The slow tail shrinks the most.** The p99.9 of a get in readrandom-unsettled fell from
  296 µs to 45 µs, and that of a read in ycsb-c from 212 µs to 45 µs. The p99 of a scan in
  ycsb-e fell from 296 µs to 110 µs.
- **seekrandom-100 is a control.** In the accounting run below it read no run-file pages.
- **Today's readrandom often reads almost nothing.** Its 10 runs split in two: 7 took 165 to
  175 ms and 3 took 260 to 304 ms. In the accounting run below, 2 of today's 4 runs read 0 or 12
  pages in readrandom and took 196 ms. We infer that readrandom-unsettled had already loaded the
  compacted run in those runs. The dedicated WebWorker's runs always read every page.

A second run timed every run-file read inside the engine, 4 runs per side. readrandom counts
only the runs that read every page: 2 of today's and all 4 of the dedicated WebWorker's.

| Phase | Run-file reads | MB read | Read p50 | Read time, median bench run | Wall time |
|---|---:|---:|---:|---:|---:|
| `fillrandom` readrandom | 353 | 11.3 | 175 → 20 µs | 75 → 9 ms | 258 → 188 ms |
| `fillrandom` readrandom-unsettled | 438 → 389 | 14.3 → 12.8 | 200 → 25 µs | 136 → 15 ms | 354 → 242 ms |
| `fillseq` readseq | 355 | 11.4 | 185 → 25 µs | 89 → 21 ms | 167 → 98 ms |
| `ycsb-c` | 353 | 11.3 | 170 → 25 µs | 69 → 12 ms | 250 → 189 ms |

- **readseq and ycsb-c make the same reads on both paths.** The per-read cost matches the probe.
- **Each phase saves about the read time it removes.** Wall time saved against read time
  removed, in the order of the table: 70 and 66 ms, 112 and 121, 69 and 68, 61 and 57.
- **After the change, reads are 5% to 21% of a phase.** The rest is engine work on the main
  thread, so the read path has little left to give.

## App benchmarks

The app families at size `small`, one message per page. 5 runs per side, interleaved, 130 runs
in all, none failed, every read checked.

| Workload, phase | Today ms | Dedicated WebWorker ms | Change | Ranges |
|---|---:|---:|---:|---|
| `linearlite/browse` cold-open | 162 (141–221) | 133 (100–141) | −18% | **faster, apart** |
| `linearlite/browse` cold-open, until the list total is right | 92.7 (68.6–111) | 38.5 (27.0–56.1) | −58% | **faster, apart** |
| `linearlite/browse` sort | 88.5 (74.0–103) | 71.4 (63.1–73.9) | −19% | **faster, apart** |
| `linearlite/browse` filter | 316 (308–331) | 385 (337–447) | +22% | **slower, apart** |
| `linearlite/browse` search | 415 (312–541) | 496 (314–755) | +19% | overlap |
| `linearlite/browse` jump | 338 (314–424) | 516 (503–625) | +52% | **slower, apart** |
| `linearlite/browse` board | 47.4 (42.6–51.8) | 45.3 (42.6–53.3) | −4% | overlap |
| `linearlite/browse` threads | 83.7 (74.3–89.5) | 85.4 (66.9–95.6) | +2% | overlap |
| `linearlite/first-sync` first-sync | 3322 (3070–3441) | 3041 (2764–3231) | −8% | overlap |
| `tanstack/todos` coldopen | 370 (347–459) | 263 (260–272) | −29% | **faster, apart** |
| `tanstack-ondemand/queries` coldopen | 9.01 (7.67–10.1) | 11.2 (9.51–13.9) | +24% | overlap |
| `tanstack-ondemand/queries` first-query | 69.0 (68.0–70.7) | 71.5 (64.0–89.9) | +4% | overlap |
| `tanstack-ondemand/queries` query-owner | 570 (554–608) | 554 (547–595) | −3% | overlap |
| `tanstack-ondemand/queries` query-page | 665 (587–749) | 545 (530–578) | −18% | **faster, apart** |
| `tanstack-ondemand/queries` query-ids | 264 (212–300) | 188 (167–232) | −29% | overlap |
| `table/todos` coldopen | 10.5 (9.54–17.0) | 12.4 (9.72–24.8) | +19% | overlap |
| `table/todos` get-bulk | 19.3 (17.8–25.0) | 18.3 (14.3–20.4) | −6% | overlap |
| `table/todos` where-owner | 331 (312–427) | 298 (285–327) | −10% | overlap |
| `table/todos` page-created | 40.0 (37.5–66.0) | 27.2 (26.3–29.3) | −32% | **faster, apart** |
| `pages/type` reopen | 146 (141–186) | 136 (136–144) | −7% | overlap |
| `yjs/many-docs` load | 50.0 (46.4–56.8) | 47.9 (46.9–55.7) | −4% | overlap |
| `yjs/trace` load | 60.4 (54.8–13190) | 47.5 (45.5–52.7) | −21% | **faster, apart** |
| `yjs/whiteboard-session` cold-open | 101 (86.6–111) | 99.1 (81.5–106) | −2% | overlap |
| `automerge/many-docs` load | 201 (191–206) | 203 (199–213) | +1% | overlap |
| `automerge/trace` load | 57.1 (54.3–62.1) | 60.9 (59.1–65.6) | +7% | overlap |
| `fate/read-cache` cold-load | 2676 (2631–3443) | 2524 (2418–2652) | −6% | overlap |
| `fate/mutations` deliver | 1015 (976–1082) | 1082 (978–1120) | +7% | overlap |

- **Seven of 27 steps are faster with ranges apart,** by 18% to 32%, and by 58% for the time
  until linearlite's list total is right. They are cold opens, sorting, paged queries and a
  trace load. We infer that these steps load many pages. The app benchmarks don't count reads.
- **Only linearlite filter and jump are slower with ranges apart.** See below.
- **Other cold loads did not move,** such as Automerge, fate and `yjs/many-docs`. We infer that
  main-thread engine and app work limits them, as in the engine benchmarks.
- **First opens of an empty database are left out.** The prototype touched OPFS before that
  timed open, so only today's path paid OPFS's first-touch cost there. Those opens looked 1.5 to
  5 ms faster through the dedicated WebWorker.
- One of today's `yjs/trace` runs took 13 s. The median is unaffected.

**Opening a database that has data is slower in every workload.** The `open` call alone, median
ms. Ranges are apart in 6 of 13, by 2.4 to 4.8 ms.

| Workload, phase | Today | Dedicated WebWorker | Ranges |
|---|---:|---:|---|
| `automerge/many-docs` load | 5.32 (4.04–7.35) | 8.38 (7.39–9.27) | apart |
| `automerge/trace` load | 4.20 (3.84–6.35) | 7.57 (6.52–9.51) | apart |
| `fate/mutations` deliver | 4.51 (3.93–6.13) | 8.22 (7.55–10.8) | apart |
| `fate/read-cache` cold-load | 7.59 (7.36–8.27) | 12.4 (10.8–15.1) | apart |
| `tanstack-ondemand/queries` query-page | 11.6 (8.65–12.4) | 14.0 (12.7–25.8) | apart |
| `yjs/many-docs` load | 6.10 (5.26–6.99) | 9.84 (8.40–10.8) | apart |
| `linearlite/browse` cold-open | 12.5 (11.9–20.1) | 21.8 (14.2–34.0) | overlap |
| `pages/type` reopen | 6.73 (6.27–16.4) | 7.27 (7.10–8.30) | overlap |
| `table/todos` coldopen | 9.82 (8.64–14.2) | 11.9 (9.39–24.1) | overlap |
| `tanstack-ondemand/queries` coldopen | 8.93 (7.58–10.0) | 11.1 (9.41–13.8) | overlap |
| `tanstack-ondemand/queries` query-ids | 9.63 (8.08–11.8) | 14.7 (9.70–60.6) | overlap |
| `yjs/trace` load | 6.61 (6.08–10.9) | 8.51 (6.49–11.1) | overlap |
| `yjs/whiteboard-session` cold-open | 7.03 (4.74–16.6) | 9.19 (8.84–10.3) | overlap |

`tanstack/todos` times its whole cold load as `open`, so it is in the table above instead. We
infer that the extra time is the dedicated WebWorker starting up, plus about 0.16 ms more per run
file to open (see the probe). Neither was measured on its own.

## The linearlite filter and jump slowdown

The two slower steps read the same pages and show the same rows on both paths. They get slower
only when the next interaction starts right after the last one. The browse workload was rerun
in two more sessions, linearlite at size `small`:

- **Back to back**, as the workload is written. The next interaction starts one macrotask after
  the bench counts the last view as shown. Three paths, 5 runs each: today, the dedicated
  WebWorker with one message per page, and the dedicated WebWorker with batched replies.
- **1 s idle**, a second of nothing after each interaction. Two paths, 4 runs each: today, and
  the dedicated WebWorker with one message per page.

Median ms and range:

| Step | Back to back: today | One message per page | Batched | 1 s idle: today | One message per page |
|---|---:|---:|---:|---:|---:|
| cold-open | 185 (162–241) | 98.1 (88.7–112) | 105 (96.2–120) | 169 (134–508) | 98.2 (90.2–110) |
| sort | 93.4 (73.8–114) | 83.1 (52.7–95.9) | 91.7 (72.2–127) | 113 (76.0–137) | 72.7 (56.6–107) |
| filter | 301 (292–372) | 409 (322–459) | 291 (253–300) | 313 (284–336) | 273 (257–294) |
| search | 432 (318–529) | 442 (322–637) | 517 (428–562) | 419 (359–547) | 409 (362–537) |
| jump | 358 (297–387) | 559 (520–632) | 411 (351–662) | 323 (267–373) | 233 (224–245) |

- **With a second of idle, the dedicated WebWorker has the lower median on every step except
  search, which is even.** Cold-open and jump are apart: jump goes from 323 to 233 ms. Sort and
  filter overlap.
- **Batched replies remove most of the slowdown back to back.** Filter matches today. Jump is
  15% slower instead of 56%, and its range still overlaps today's.
- **Search varies too much between runs to call** in every variant.
- A profiled jump, one message per page against today, kept the tab's main thread busy for
  661 ms against 395 ms. The app's live-query code took about twice as long.

Our reading, inferred and not confirmed with a trace: with one message per page, each page
lands in its own task. Work started by one interaction is still running when the bench counts
its view as shown, so its cost lands in the next step. That also flatters the step that started
the work, so the back-to-back gains on cold-open and sort may be overstated. Batching gives that
work fewer tasks to spread over.

## What adopting it would take

- A feature check, with today's path kept as the fallback for Firefox and Safari. That means
  two read paths to maintain.
- Batched replies. In the probe they cost about 1 ms per 450 pages against one message per
  page: 4.99 against 3.98 ms, ranges overlapping.
- Closing the handle before releasing the run lock.
- Up to about 5 ms more to open a database that has data. Starting the dedicated WebWorker with
  the page may hide part of it. Not measured.

## Not measured

- Firefox and Safari, where the option is not supported, and Chrome on Android.
- Two tabs reading the same run at once. The probe opened a second read-only handle from another
  dedicated WebWorker, but no bench ran two tabs.
- Sizes above `small`.
- Memory use of the dedicated WebWorker.
- Batched replies across all app families. Only linearlite browse ran with them.
- How the extra open time splits between starting the dedicated WebWorker and opening files.
