# Reading run files synchronously through a SharedArrayBuffer

Status: shipped. `openDb({ syncReads })` reads run files through a dedicated worker's read-only
sync access handles and a shared buffer, as [sync-reads.md](../sync-reads.md) describes. It is
off unless an app imports `@opfs-lsm/kv/sync-reads`.
[worker-read-only-handles.md](worker-read-only-handles.md) rejected the same handles behind
`postMessage`.

Date: 2026-11-25. Chrome 158 headless, macOS arm64, Apple M2 Pro. The probe and the prototype
ran on `3d482e3e` plus local changes, the last section on the code that shipped. The load average
was 2 to 5.6 during the runs, and a macOS XProtect scan held one core for part of them. Every
comparison of the prototype alternated its sides inside one run.

## Question

A tab read a page of a run file with `file.slice().arrayBuffer()`, a round trip to the browser
process that also made every cold read asynchronous. Can a tab read a run file with no wait, and
does that speed up what an app waits for?

## The read

[`sab-sync-read/`](sab-sync-read/) times one read of a 32 KiB page of a 16 MiB file each way a
tab could ask for it: `node docs/research/sab-sync-read/run.mjs`. Three fresh Chrome launches of
8 rounds, 4,096 reads per row and launch, the rows rotated inside each round. Every read was
checked against the bytes written, and none failed. Each cell is the range of the three means.

| Read of one page | Mean |
|---|---:|
| `file.slice().arrayBuffer()` on the main thread | 193–197 µs |
| Worker with a sync handle, asked by `postMessage`, the buffer transferred back | 21–24 µs |
| Shared buffer, the tab awaits `Atomics.waitAsync`, the worker parked on `waitAsync` | 16–20 µs |
| Shared buffer, the tab spins, the worker parked on `waitAsync` | 16–17 µs |
| Shared buffer, the tab spins, the worker blocked in `Atomics.wait` | 14–15 µs |
| Shared buffer, the tab spins, the worker spins after each read | 6.0–7.2 µs |

- **The limit was the read.** With the worker spinning, a request with no read took 0.3 µs, and
  copying a page out of the shared buffer took about 3 µs.
- **A short spin did as well as a long one.** 2,000 loads after a read, about 18 µs, measured 6.5
  to 7.0 µs a read, the same as 200,000 loads.
- **Blocking the worker bought nothing.** `Atomics.wait` was within 3 µs of `waitAsync`, and a
  blocked worker takes no message.
- **Size.** A 4 KiB read took 2 µs against 205 µs. A 1 MiB read took about 155 µs against
  630 µs, and blocked the main thread for 1.1 to 2.2 ms at worst.
- **450 pages asked at once.** One read per page took 55 to 58 ms, the coalesced spans kv uses
  6.9 to 8.0 ms, and the shared buffer 2.6 to 2.9 ms.
- **Opening a file cost more.** `getFileHandle` and `createSyncAccessHandle` took 267 µs a file
  in sequence and 79 µs in parallel, against 173 and 39 µs for `getFile`. A close took 100 µs.
- **The worker took 2.7 to 2.9 ms to run its script** and 3.5 to 3.9 ms to hold its first handle.

## The prototype in the bench suite

Every kv-based contender ran against a twin with sync reads whose open waited for the worker's
handles: size `small`, 5 interleaved reps a side, 155 runs, none failed. A difference counts when
an exact rank-sum test gives p below 0.05. Of 167 operation rows, 59 were faster, 24 slower and
84 not separated, where chance alone would mark about 8.

| Row | Async | Sync | |
|---|---:|---:|---:|
| `kv/large-values`, 500 scattered 8 KiB values in a fresh tab | 13.4 ms | 3.50 ms | 3.84× |
| The same, 500 neighbouring values | 4.18 ms | 3.11 ms | 1.34× |
| `kv/fillrandom`, random gets in a fresh tab, mean | 2.04 µs | 1.25 µs | 1.63× |
| `kv/ycsb-a`, reads while half the calls write | 6.73 µs | 2.85 µs | 2.36× |
| `kv/two-tabs`, first get after a catch-up | 650 µs | 200 µs | 3.25× |
| Tracker, rows at 90% of a project's list, cold | 10.4 ms | 5.04 ms | 2.06× |
| Tracker, open issues by priority, cold | 12.2 ms | 6.23 ms | 1.96× |
| Tracker, open issues with a label, cold | 10.0 ms | 5.07 ms | 1.98× |
| Tracker, an issue with its comments, cold | 5.78 ms | 3.05 ms | 1.90× |
| Tracker, title search, cold | 8.05 ms | 4.23 ms | 1.90× |
| `kv/fillrandom`, open in a fresh tab | 9.59 ms | 11.5 ms | 0.83× |
| Tracker, open in a fresh tab | 23.2 ms | 25.6 ms | 0.91× |

- **IndexedDB read the scattered values in 8.0 ms** (4 reps, a separate run the same day). That
  was the row where kv lost to it.
- **Warm reads and writes did not move,** except the tracker's warm title search, 237 to 289 µs,
  which was not explained.
- **Automerge and TanStack Query gained nothing.** Automerge's own load of a document took most
  of its cold open.
- **Nearly every slower row was an open,** by 1 to 2.5 ms.

## What was tried and not kept

- **A worker asked by `postMessage`.** It needs no cross-origin isolation, but its 21 to 24 µs
  read stays asynchronous.
- **A worker blocked in `Atomics.wait`.** The bench driver samples each worker's heap over
  DevTools, and a blocked worker never answered, so a run hung at its end.
- **An open that waits for the handles.** It made every open 2 to 2.5 ms slower. For a tab that
  opens and gets one key, open plus first get went from 10.7 to 13.6 ms.
- **An open that does not wait, with reads async until a handle is ready.** A fresh tab's first
  reads then made 0 sync reads. What shipped does not wait at open, and a read issued while its
  file's handle is opening waits for that handle.
- **A boolean option served by a dynamic `import()`.** In a Vite 8 build the first dynamic import
  brings in a preload helper of about 700 gzip bytes, which took kv at import from 19,363 to
  20,340 bytes for every app. With the option as an export the app imports, it is 19,512.
- **Twin bench contenders.** The bench switches with `--sync-reads` instead.

## A stall that was the TanStack DB adapter's

Batched updates through `@opfs-lsm/tanstack-db` on demand took 4.64 ms a call with sync reads
against 2.14 ms. One call of the 112 took about 300 ms against 27 ms, and the phase's 106 sync
reads took 3 ms in all. A variant with the worker and async reads was level, so the cause was not
the worker, its handles or its spin. A CPU profile showed the time under the adapter's eviction.

Each load that settled queued a timer, and each timer walked every row the collection held. With
async reads the timers fired while another load was pending and returned at once. With sync reads
ten loads settled in one task, and ten walks of about 30 ms landed in the first timed call. A
queued eviction now runs only while one is owed. Updates then took 2.13 ms on all three variants
(5 reps each). On `main` with async reads the fix changed nothing: 248 ms under the eviction in
three profiles before and 248 to 257 ms after.

## Browser facts

- In Chrome 158, in a dedicated worker, `"mode" in FileSystemSyncAccessHandle.prototype` was
  true, a handle opened with `{ mode: "read-only" }` reported `mode` as `"read-only"`, and its
  `read()` took a view on a `SharedArrayBuffer`.
- A worker blocked in `Atomics.wait` answered no DevTools command.
- The bench driver pauses each new dedicated worker until it has installed its wasm hook. So a
  worker likely starts later in the bench than in an app. This was inferred, not measured.

## What shipped, measured

`--sync-reads` against the default, one run after the other, size `small`, 5 reps a side, no run
failed. Every sync run recorded sync reads in its stats, and no async run did. "Apart" means the
two min–max ranges did not overlap.

```sh
node bench/cli.ts run kv/fillrandom kv/large-values kv/fillseq --contenders kv --seed N [--sync-reads]
node bench/cli.ts run tracker/goals --contenders docstore [--sync-reads]
```

| kv row, async → sync | Seed 1 | Seed 2 | Seed 3 |
|---|---:|---:|---:|
| 500 scattered 8 KiB values, fresh tab | 13.2 → 3.57 ms | 13.1 → 3.58 ms | 13.4 → 3.58 ms |
| 500 neighbouring 8 KiB values, fresh tab | 4.13 → 3.23 ms | 4.13 → 3.27 ms | 4.14 → 3.26 ms |
| Random gets in a fresh tab, mean | 1.99 → 1.40 µs | 2.16 → 1.45 µs | 2.00 → 1.32 µs |
| Random gets over warm pages, mean | 1.29 → 1.28 µs | 1.29 → 1.46 µs | 1.35 → 1.29 µs |

The first three rows were apart on every seed. The warm row is the one expected not to move, and
it did not separate on any seed.

| Tracker goal, cold, seed 1 | Async | Sync | |
|---|---:|---:|---:|
| Rows at 90% of a project's list | 9.94 ms | 4.52 ms | 2.20× |
| Open issues by priority | 12.2 ms | 5.86 ms | 2.07× |
| Open issues with a label | 9.89 ms | 4.69 ms | 2.11× |
| An issue with its comments | 6.03 ms | 2.84 ms | 2.12× |
| Title search | 7.81 ms | 3.85 ms | 2.03× |
| Issues per status | 3.68 ms | 2.55 ms | 1.44× |
| A project's board, 6 reads together | 8.12 ms | 7.19 ms | 1.13× |
| Open in a fresh tab | 23.3 ms | 24.0 ms | not separated |

- **Every cold goal but the recent issues was faster,** and the tracker's open did not separate
  in any of its 15 rows.
- **A kv open in a fresh tab was slower on two seeds of three:** 9.45 to 11.5 ms and 9.34 to
  10.1 ms. The get after it went from 1.22 to 1.70 ms on seed 1 and did not separate on the
  others. A tab that opens a small database and reads one key gains nothing.
- **Batched updates through TanStack DB on demand were level,** 2.13 ms either way.

## Not measured

- Firefox and Safari, which have no read-only sync access handle, and Android.
- A page in the back/forward cache, and `destroyDb` against a frozen tab, with sync reads on.
- The read that gives up after 20 ms and the worker's error path, in a browser.
- The tracker at 200,000 issues, and the tracker on a seed other than the default.
