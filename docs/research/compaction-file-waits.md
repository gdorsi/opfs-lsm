# Overlapping a compaction step's file waits

Status: shipped. A compaction step that a flush waits for, and an L0 step of over half
`maxSources`, keeps one output write in flight and reads its output level one window ahead, as
design.md, "Merging" describes. The always-on form was rejected.

Date: 2026-11-25. Chrome 158 headless, macOS arm64, Apple M2 Pro, commits `9514f729` (before) and
`21de1eb8` (after), load average 2 to 4. A probe run is one replay of `tracker/goals` on docstore
with `settle` and `recent`, variants alternated. A bench run is
`pnpm bench tracker/goals --size <size> --contenders tracker/docstore`, 5 reps, before and after in
separate sessions, compared with `node bench/cli.ts compare`.

## Question

The `replay` of `tracker/goals` at 200,000 issues held a `sync` batch for about a second, about 25
times a run ([hot-path-profile-pass.md](hot-path-profile-pass.md), "Write tail latency"). What
does that batch wait for, and can the wait be shorter?

## What a slow write waited for

Temporary timers in the tab and the SharedWorker, one replay at size `large`:

- The replay wrote faster than compaction merged. About every 3 s L0 reached `l0StopRuns`, 48.
  The flush then waited 1.3 s (median of 20 waits) for the L0 step in progress, which took 2.7 s.
- The tab's memtable reached `memtableBytes` about 0.2 s into that wait, and the next write
  waited 1.1 s (median of 27 waits, 21.9 s in all of a 58 s replay).
- An L0 step started with about half the runs of the stop and rewrote the L1 runs they
  overlapped. The last L0 steps of the replay each wrote about 290 MB.

A CPU profile of the SharedWorker over the replay showed it idle for 72 s of 100 s. The merge
driver's own time, summed over the 173 steps of one replay:

| | time | calls | bytes |
|---|---:|---:|---:|
| the session's work between stops | 18.4 s | | |
| waits for input reads | 17.1 s | 46,643 | 6.78 GB |
| waits for output writes | 24.4 s | 46,585 | 6.27 GB |

Each wait was taken alone: the session ran, then one read or one write, then the session again.
Of the reads, 92% asked for the bytes that follow the last read of one source, the output level.

## What was tried

Seconds for the replay at size `large`, probe runs, variants alternated:

| variant | replay | longest `sync` batch | verdict |
|---|---:|---:|---|
| before | 56.9 to 58.2 (4 runs) | 1.34 to 1.38 s | |
| one output write in flight | 50.0 to 50.4 (4 runs) | 0.85 to 0.92 s | kept, then gated |
| and one window of the output level read ahead | 45.9 to 47.6 (3 runs) | 0.56 to 0.62 s | kept, then gated |
| and every write of a run in flight | 47.4 (1 run) | 0.66 s | rejected: no gain |
| and a flush only at `flushRunBytes` | 45.0 (1 run) | 0.50 s | rejected: within the noise, and an open replays a longer tail |

With one write in flight, the waits for writes fell from 24.4 s to 5.5 s and the waits for reads
rose from 17.1 s to 26.3 s: a read waited behind the write in flight. The overlap hid a wait
behind the session's work and not behind another wait, which fits a deeper write queue gaining
nothing. Why the calls queue was not looked into.

**Always on, the overlap cost the tabs.** Bench runs of the always-on form against before:

| | before | always on |
|---|---:|---:|
| `replay` at `large`, ops/s | 15.1k (15.0k to 15.4k) | 18.0k (17.3k to 19.0k) |
| one `edit` after the sprint close at `large` | 0.421 ms (0.410 to 0.435) | 0.559 ms (0.487 to 0.617) |

At size `small`, where no flush ever stopped, 5 alternated probe runs took 2.85 to 2.90 s before
and 3.19 to 3.84 s always on. A merge that kept the files busy took file time from the tab's
reads and commits whenever the merge was not what the tab waited for.

**Gated on a waiting flush**, the form kept the tab's times and lost most of the gain: 16.1k
ops/s (15.5k to 16.9k) in the bench run, because the gate opened about half way through a step.

**Gated on a waiting flush or a step that will make one wait** is the form that shipped. An L0
step that starts with over half the runs of the stop ends after L0 is full, so it overlaps from
its start. Probe runs, 4 rounds of before, the first gate and this one:

| | before | flush waits | or over half the stop |
|---|---:|---:|---:|
| replay at `large` | 57.6 to 64.4 s | 51.0 to 55.1 s | 47.7 to 50.2 s |
| longest `sync` batch | 1.37 to 1.89 s | 0.90 to 1.15 s | 0.65 to 0.69 s |
| one `edit` at `large` | 0.42 to 0.46 ms | 0.40 to 0.51 ms | 0.41 to 0.47 ms |
| replay at `small` | 2.83 to 2.96 s | 2.81 to 3.00 s | 2.83 to 2.97 s |

## Result

Bench runs, before against after, medians and ranges of 5 runs:

| `replay` at `large` | before | after | |
|---|---:|---:|---|
| ops/s | 15.1k (15.0k to 15.4k) | 18.3k (16.9k to 18.5k) | 1.21× |
| mean `sync` batch | 5.27 ms (5.19 to 5.35) | 4.25 ms (4.20 to 4.59) | 1.24× |
| mean `import` batch | 22.7 ms (22.0 to 22.9) | 20.5 ms (20.4 to 22.3) | 1.10× |
| `sync` p99.9, all runs pooled | 1,212 ms | 500 ms | |
| slowest `sync` batch | 1,389 ms | 802 ms | |

`compare` marked those three rows and no other row of the workload at `large`. At `small` it
marked no row of `replay` or `recent`: 30.3k against 30.6k ops/s, and an `edit` at 0.289 against
0.279 ms. It marked the opens of the goal phases at `small` 1.1× faster after. No step overlaps at
that size, and the two sessions ran 20 minutes apart, so that is drift between sessions.

The cost is 0.4 kB raw in the SharedWorker chunk, about 0.1 kB brotli after open and nothing at
import. The kv and docstore budgets after open went up by 100 B each.

## Not done

- A window read ahead is a full window, and the session then asks for what its own window has
  free, so some bytes of the output level are read twice. Not measured in Chrome.
- The gate is per database. A step of another database in the same SharedWorker, which holds
  the one merge slot, does not overlap for a flush that waits behind it.
- The merge still waits on its files for longer than it computes. The other sources' reads are
  not read ahead: 48 more windows would not fit `compactionMemoryBytes`.
- An L0 step still rewrites about 290 MB of L1 for half an L0 stop of new runs at this size.
  The planner's scores set how large L1 grows, and no score was changed here.
- A write still waits 0.5 s at p99.9 at this size. Shorter waits need a slowdown before the stop,
  as RocksDB's write controller has, or a step that ends sooner.
