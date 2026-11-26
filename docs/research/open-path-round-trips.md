# Round trips in a cold open

Status: shipped. An open overlaps its IndexedDB and OPFS steps, reads the newest manifest and opens
its runs while IndexedDB opens, opens runs from the manifest copy in `meta` while it reads the
manifest file, and the host flushes a waiting tail after 2 s with no write or 5 s of writes, so a
fresh tab replays a short tail ([Installing a generation](../design.md#installing-a-generation),
[Trigger](../design.md#trigger)). One folder level fewer was rejected. Not done: file handles kept
in IndexedDB. A read of every run's tail at open was rejected, and the block indexes later moved
into the manifest file ([cold-read-run-metadata.md](cold-read-run-metadata.md)).

Date: 2026-11-11 to 2026-11-26. Chrome 157 headless, macOS arm64, Apple M5 Max, and Apple M2 Pro
with Chrome 158 for the last two sections. Other work ran on the machine during every measurement, so each comparison
rotates its variants inside one run.

## Question

In the bench suite kv opens a 100,000-entry database in 8.5 ms against 1.0 ms for a plain
IndexedDB store, and docstore in 17.7 ms against 2.1 ms for Dexie (issue 139). Where does the
time go, and how much of it can go away without changing the design?

## Verdict

An open is a chain of calls to the browser process, at 0.3 to 0.5 ms each on a page that already
opened the database and 0.6 to 0.9 ms each in a fresh tab. No step dominates, so the gains came
from running steps side by side and from keeping the WAL tail short:

| change | shipped | measured gain |
|---|---|---|
| A: IndexedDB opens while OPFS does; WAL meta and the manifest listing in parallel; read-only WAL transactions do not wait for `complete` | 2026-11-11 | 0.39 to 0.71 ms per open, paired |
| B: directory handles kept per database; a run's file handle looked up while its lock is requested | 2026-11-11 | A + B 0.46 to 0.97 ms, paired |
| 1: a flush stores the manifest's bytes in `meta`; the tab opens the runs while it reads the manifest file | 2026-11-18 | fresh-tab open 4.99 to 4.22 and 4.48 ms |
| 2: overlapped lookups and recovery check, see below | 2026-11-18 | fresh-tab open 3.78 and 3.90 ms |
| idle flush after 2 s with no row, when an eighth of `maxWalBytes` waits | 2026-11-18 | fresh-tab open with a 0.66 MiB tail 7.55 to 3.90 ms |
| idle flush also 5 s after the first row since the last flush began | 2026-11-22 | `reopen` opens over 20 ms: 2 of 10 to 0 of 10 |
| the newest manifest read and its runs opened while IndexedDB opens | 2026-11-26 | fresh-tab open 10.3 to 8.97 ms, median of 25 |

On 2026-11-23 the open also started opening the runs before it read the tail's records, and read
the tail in ranges of 100 records, all in flight. This note has no measurement of that change.

## Where the time went, 2026-11-11

A probe opened the same database, did one `get` and closed it, 40 times on one page, with a
timer around every await. Medians of one run, ms:

| step | time | calls to another process |
|---|---:|---|
| OPFS directory | 1.33 | `getDirectory`, two `getDirectoryHandle` |
| IndexedDB open | 0.41 | one |
| recovery: WAL meta | 0.66 | one transaction |
| recovery: list manifests | 0.68 | directory lookup, listing |
| WAL tail | 0.49 | one transaction |
| read the manifest | 1.72 | directory, file handle, `getFile`, `arrayBuffer` |
| open 5 runs, in parallel | 1.46 | per run: lock, directory, file handle, `getFile` |
| whole open | 7.40 | |
| first `get` | 4.45 | per run on the way: layout read, then a page |

The open was about a dozen calls to the browser process in sequence. The SharedWorker's start is
not on this path: open does not wait for it.

## Paired variants, 2026-11-11

Each variant took its turn within a round, 100 rounds a run, three runs. The numbers are the
median of the per-round difference from the unchanged code, in ms, one per run. `control` is the
unchanged code under a second name.

| variant | open | first `get` |
|---|---|---|
| control | −0.03, −0.18, +0.07 | −0.05, +0.39, −0.12 |
| A | −0.51, −0.71, −0.39 | within the control |
| A + B | −0.97, −0.95, −0.46 | within the control |
| A + B + load the recorded generation while recovery lists | −1.06, −1.48, −0.69 | within the control |
| A + B + load early + read every run's layout at open | −0.94, −1.13, −0.49 | −0.43, −0.45, −0.36 |

An earlier pass that compared medians of separate variants, without pairing, showed single
changes worth 0.2 to 0.6 ms. A run in which every variant was by accident the unchanged code
spread just as wide, so those figures are not used.

**Loading the generation early** was worth a further 0.1 to 0.5 ms. On 2026-11-11 it was not
taken: it moved a load into recovery, and when recovery then recorded a different manifest, the
tab held a generation it had to drop. Change 2 of 2026-11-18 runs the recovery check while the
tail is read and the runs open, so the load now overlaps recovery.

**Reading every run's tail at open** was rejected. It took 0.4 ms off the first `get`, but it
read up to 128 KiB per run at open, and a large database has many runs that a given tab never
reads. On 2026-11-25 the block indexes moved into the manifest file, which an open already read,
and the first `get` no longer waits for a tail ([cold-read-run-metadata.md](cold-read-run-metadata.md)).

## Fresh tabs, 2026-11-18

Chrome 157.0.8103.79 headless, Apple M5 Max. Every figure here is the `coldopen` phase of
`kv/fillrandom` at size `small` (100,000 entries, 5 runs on disk): one open per fresh tab, 12
tabs a run, median. These figures are not comparable with the one-page probe above.

| build | open, median of 12, per run |
|---|---|
| before | 4.99, 4.99 ms |
| 1: a flush stores the manifest's bytes in `meta`; the tab opens the runs while it reads the manifest file | 4.48, 4.22 ms |
| 2: and `opfs-lsm/` is looked up while the open lock is requested, the database folder resolves behind the first file call, and recovery checks while the tail is read and the runs open | 3.78, 3.90 ms |

The first `get` after the open stayed at 1.38 to 1.44 ms in every build.

Where the open went in build 1, whose steps still ran one after another, ms from one step to
the next (the 4.22 ms run):

| step | time |
|---|---:|
| the open lock | 0.59 |
| OPFS directory (three lookups), with the IndexedDB open beside it | 1.06 |
| recovery: WAL meta, and the listing of `m/` | 1.12 |
| WAL tail, the part still to come | 0.14 |
| manifest file and runs, together | 1.18 |

The open in build 2, ms from the `openDb` call to the end of each step (a 4.03 ms run, with
the timers in):

| step | at |
|---|---:|
| open lock granted | 0.69 |
| IndexedDB open | 1.50 |
| `opfs-lsm/` found (two lookups, started at 0) | 1.89 |
| WAL tail and manifest copy read | 2.11 |
| database folder found | 2.50 |
| recovery check done | 3.14 |
| manifest file read, runs open | 3.65 |
| open resolves | 4.03 |

In build 2 the chain that decided the time was OPFS alone: root, `opfs-lsm/`, the database folder,
`m/` or a level folder, the file handle, `getFile`, and for the manifest its bytes. IndexedDB had
everything a tab needs 2.1 ms in.

**The manifest copy alone was rejected.** The first cut loaded a generation from the copy alone.
Two tests refused it. After a power loss IndexedDB can keep the commit of a flush while OPFS lost
its manifest and left its run created and empty, and the tab then opened a run with no bytes. And
a recorded manifest that does not decode must refuse the open, which only reading it can tell. So
the copy removes no read. It lets the run opens start one step earlier.

## A WAL tail at open, 2026-11-18

A tab replays the unflushed WAL before `openDb` resolves, and the host flushed only at
`maxWalBytes`, 1 MiB. What does a tail cost a fresh tab, and what does flushing it cost the reads
that follow?

A temporary bench workload filled 100,000 entries and settled, then overwrote 6,000 of them in
batches of 1,000, which left 0.66 MiB of ops in the WAL. It then opened in a fresh tab after the
SharedWorker had exited, and read one overwritten key, 20 more, and one key that was not
overwritten. The same open ran three times: right after the burst, after 3 s with a tab open and no
write, and after `settle`. Apple M5 Max, 12 fresh tabs per row, p50:

| The fresh tab finds | `openDb` | First recent `get` | Each of 20 more recent `get`s | First other `get` |
|---|---:|---:|---:|---:|
| the burst in the WAL | 7.55 ms | 0.10 ms | under 0.01 ms | 1.82 ms |
| the burst flushed by the idle flush | 3.90 ms | 1.25 ms | 0.18 ms | 0.72 ms |
| the burst flushed and compacted (`settle`) | 3.78 ms | 1.18 ms | 0.19 ms | 0.66 ms |

- The tail costs the open 3.7 ms, about 0.6 ms per 1,000 rows of 116 bytes.
- A flushed row is read from a run page, not from memory. The first read pays 1.2 ms, the file's
  first page read, and each further key on a page not yet read pays 0.18 ms.
- From `openDb` to the first recent row, the flush wins 2.5 ms (7.65 ms against 5.15 ms). A tab
  that reads 20 scattered recent rows one by one ends level (9.8 ms against 9.2 ms for the phase).

Why an eighth: at 128 KiB by default, the tail costs an open about 0.7 ms by the rate above, which
is what the first read of the flushed run costs. Below it a flush saves nothing a first screen
would see, and a slow typist would get a run per pause.

## A writer that never pauses, 2026-11-22

Apple M2 Pro, `yjs/trace` at size `small`, kv only. Some fresh-tab opens in `reopen` took 40 to
117 ms against 6 to 10 ms for the rest.

Timestamps at each await of `openDb` showed why. In the slow tab the WAL held all 26,001 records,
1,025,088 op bytes, and no generation was recorded. That is 23 KB under the 1 MiB `maxWalBytes`.
So only the idle flush could have folded them. Every typed key restarted its 2 s wait, and a watch
the last tab left gets none. The tab replayed the whole log: 70.7 ms to read and decode it, 12.3 ms
to apply it, 89 ms for the open. The fix added the 5 s due time.

| build | `reopen` opens over 20 ms | `open` per rep, ms |
|---|---|---|
| before | 2 of 10 | 6.4 to 117.1, median 7.97 |
| with the due time | 0 of 10 | 6.4 to 10.1, median 7.91 |

Load average 5.8 to 9.8 during both runs. In 10 more runs with the timestamps, every fresh tab
replayed 300 or 301 records against 26,001 in 1 of 10 before.

## Ahead of IndexedDB, 2026-11-26

Apple M2 Pro, Chrome 158 headless, base commit `fe964869`, load average 2 to 17 from other
sessions, so every comparison is paired or interleaved.

`node bench/probes/open-paired.ts --a <packages/kv> --b <packages/kv>` opens a settled database of
100,000 entries in a fresh tab per open, 3 s after the last SharedWorker exited, one database per
build, the builds in turn. It also prints one open as a timeline of its browser calls. In 15 of 15
opens of the base commit, `indexedDB.open` returned 6.7 to 12.5 ms after `openDb` was called, the
database folder was found at 2.8 to 6.9 ms, and the first call for the manifest file started
1.3 to 2.8 ms after IndexedDB returned. The open resolved 3 to 9 ms after IndexedDB did. So on
this machine IndexedDB decided the open and OPFS sat idle for it, the reverse of the M5 Max
timeline above, where IndexedDB had answered before the folder was found.

The change: while the WAL database opens, the tab lists `m/`, reads the newest manifest and opens
its first 16 runs. The load of the generation IndexedDB names takes them when it is that one.

| measure | before | after |
|---|---:|---:|
| the probe, 30 rounds, median open | 13.61 ms | 11.43 ms |
| the probe, per-round difference, median and quartiles | | −2.17 ms, −2.54 to −1.34 |
| `coldopen` of `kv/fillrandom` at size `small`, 5 runs of 5 opens a build, the builds in turn, median | 10.28 ms | 8.97 ms |
| the same, quartiles | 9.34 to 14.55 ms | 8.65 to 10.37 ms |

A rank-sum test separates the two sets of 25 bench opens (z = −3.44). An earlier run of the probe
with the base commit as both builds gave a per-round difference of +0.13 ms, quartiles −3.22 to
+2.09, under a higher load. The first `get` after the open did not move past the spread: 2.47 and
2.67 ms in the probe. The open is now IndexedDB's open and the two transactions after it. The
change costs about 150 gzip bytes at import, and kv's import budget went from 19,300 to 19,500.

Not measured: the M5 Max, where IndexedDB answered first and the change can only add one listing
of `m/` beside the open, and Firefox and Safari.

**One folder level fewer was rejected.** A build with each database folder in the OPFS root, and
no `opfs-lsm/` above it, opened within the spread of the base commit: a per-round difference of
+0.43 ms, quartiles −3.13 to +3.01, over 30 rounds, against −0.13 ms for the base commit under a
second name. The lookup it removes runs while the open lock is requested and IndexedDB opens, so
it was not on the chain that decided the open.

## Not done

- **Handles kept in IndexedDB.** A `FileSystemHandle` can be stored in IndexedDB and used in a
  later session, which would replace every lookup with one `getFile` per run. Whether Firefox
  and Safari keep such a handle good after the folder is removed and made again was not checked.

## Not measured

- Firefox and Safari.
- docstore's own part of its open.
- A and B as committed, against `main` with pairing. Whole runs alternated three times gave 6.80,
  3.37, 5.95 ms for `main` and 4.98, 4.31, 3.33 ms for the change, which shows only that the
  spread between runs is larger than the effect.
- The cost of the extra L0 runs that the idle flush makes, to compaction over a long session. A
  writer between about 26 and 200 KiB/s flushes runs of 128 KiB to 1 MiB every 5 s instead of one
  at 1 MiB, and no workload here writes at that rate.
- A tail of many small records, where the replay costs more per byte.
