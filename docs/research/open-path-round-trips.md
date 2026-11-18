# Round trips in a cold open

Date: 2026-11-11. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, and the same build opened in 3.4 to 6.8 ms from one run to the next.
The comparisons below rotate their variants inside one run and report paired differences.

Status: five small changes are implemented, and on 2026-11-18 the manifest copy and an open whose
steps overlap ([below](#2026-11-18-the-manifest-copy-and-an-open-whose-steps-overlap)), and a
flush of a quiet database ([below](#2026-11-18-a-wal-tail-at-open-and-the-idle-flush)). Reading every run's layout at open is not.

## Question

In the bench suite kv opens a 100,000-entry database in 8.5 ms against 1.0 ms for a plain
IndexedDB store, and docstore in 17.7 ms against 2.1 ms for Dexie (issue 139). Where does the
time go, and how much of it can go away without changing the design?

## Where the time goes

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

No step dominates. The open is about a dozen calls to the browser process in sequence, at 0.3
to 0.5 ms each. The SharedWorker's start is not on this path: open does not wait for it.

## What was measured

Each variant took its turn within a round, 100 rounds a run, three runs. The numbers are the
median of the per-round difference from the unchanged code, in ms, one per run. `control` is the
unchanged code under a second name.

| variant | open | first `get` |
|---|---|---|
| control | −0.03, −0.18, +0.07 | −0.05, +0.39, −0.12 |
| A: IndexedDB opens while OPFS does; WAL meta and the manifest listing in parallel; read-only WAL transactions do not wait for `complete` | −0.51, −0.71, −0.39 | within the control |
| A + B: directory handles kept per database; a run's file handle looked up while its lock is requested | −0.97, −0.95, −0.46 | within the control |
| A + B + load the recorded generation while recovery lists | −1.06, −1.48, −0.69 | within the control |
| A + B + load early + read every run's layout at open | −0.94, −1.13, −0.49 | −0.43, −0.45, −0.36 |

An earlier pass that compared medians of separate variants, without pairing, showed single
changes worth 0.2 to 0.6 ms. A run in which every variant was by accident the unchanged code
spread just as wide, so those figures are not used here.

## Choices

**A and B are implemented.** About 0.5 to 1.0 ms of a 4 to 5 ms open. Nothing a caller can
observe changes.

**Loading the generation early is not.** It is worth a further 0.1 to 0.5 ms and it moves a
load into recovery. When recovery then records a different manifest, the tab holds a generation
it must drop, and the handling of a loaded generation above the recorded one was changed
recently. The gain does not pay for that.

**Reading every run's layout at open is not.** It takes 0.4 ms off the first `get`. It also
reads up to 128 KiB per run at open, and a large database has many runs that a given tab never
reads.

## What is left

With A and B kv still opens in several times the 0.6 to 1.0 ms of a plain IndexedDB open. What
remains is the manifest read (four calls), the run opens (three calls each after B) and two
WAL transactions. Removing those needs a design change, for example keeping the manifest's run
list where the WAL meta is, so that one read gives both. That was not prototyped.

## Not measured

- The clean implementation against `main` with pairing. Whole runs alternated three times gave
  6.80, 3.37, 5.95 ms for `main` and 4.98, 4.31, 3.33 ms for the change, which shows only that
  the spread between runs is larger than the effect.
- docstore's own part of its open.
- A new tab after the SharedWorker has exited. The probe reopens on one page.
- Firefox and Safari.

## 2026-11-18: the manifest copy and an open whose steps overlap

Chrome 157.0.8103.79 headless, Apple M5 Max. Every figure here is the `coldopen` phase of
`kv/fillrandom` at size `small` (100,000 entries, 5 runs on disk): one open per fresh tab, 12
tabs a run, median. The probe above reopened on one page, where a call to the browser process
costs 0.3 to 0.5 ms. In a fresh tab the same calls cost 0.6 to 0.9 ms each, so these figures
are not comparable with the table above.

Three changes, each measured on the same workload:

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

The chain that decides the time is now OPFS alone: root, `opfs-lsm/`, the database folder, `m/`
or a level folder, the file handle, `getFile`, and for the manifest its bytes. IndexedDB has
everything a tab needs 2.1 ms in.

### Why the manifest file is still read

The first cut loaded a generation from the copy alone. Two tests refused it. After a power
loss IndexedDB can keep the commit of a flush while OPFS lost its manifest and left its run
created and empty, and the tab then opened a run with no bytes. And a recorded manifest that
does not decode must refuse the open, which only reading it can tell. So the copy removes no
read. It lets the run opens start one step earlier.

### Not done

- **Fewer folder levels.** Each level is one call on the chain that decides the open. The
  database folder under the root and the runs beside the manifests would take two off, about
  1.2 ms by the timeline above. It changes the layout on disk. Not prototyped.
- **Handles kept in IndexedDB.** A `FileSystemHandle` can be stored in IndexedDB and used in a
  later session, which would replace every lookup with one `getFile` per run. Whether Firefox
  and Safari keep such a handle good after the folder is removed and made again was not checked.
- Firefox and Safari.

## 2026-11-18: a WAL tail at open, and the idle flush

Chrome 157 headless, macOS arm64, Apple M5 Max, 12 fresh tabs per row.

**Question.** A tab replays the unflushed WAL before `openDb` resolves, and the host flushed only
at `maxWalBytes`, 1 MiB. What does a tail cost a fresh tab, and what does flushing it cost the
reads that follow?

**Probe.** A temporary bench workload: fill 100,000 entries and settle; overwrite 6,000 of them
in batches of 1,000, which leaves 0.66 MiB of ops in the WAL; then open in a fresh tab after the
SharedWorker has exited, read one overwritten key, 20 more, and one key that was not overwritten.
The same open ran three times: right after the burst, after 3 s with a tab open and no write, and
after `settle`. p50:

| The fresh tab finds | `openDb` | First recent `get` | Each of 20 more recent `get`s | First other `get` |
|---|---:|---:|---:|---:|
| the burst in the WAL | 7.55 ms | 0.10 ms | under 0.01 ms | 1.82 ms |
| the burst flushed by the idle flush | 3.90 ms | 1.25 ms | 0.18 ms | 0.72 ms |
| the burst flushed and compacted (`settle`) | 3.78 ms | 1.18 ms | 0.19 ms | 0.66 ms |

**What it shows.**

- The tail costs the open 3.7 ms, about 0.6 ms per 1,000 rows of 116 bytes.
- A flushed row is read from a run page, not from memory. The first read pays 1.2 ms, the file's
  first page read, and each further key on a page not yet read pays 0.18 ms.
- From `openDb` to the first recent row, the flush wins 2.5 ms (7.65 ms against 5.15 ms). A tab
  that reads 20 scattered recent rows one by one ends level (9.8 ms against 9.2 ms for the phase).

**Choice.** The host flushes a database after 2 s with no row, when at least an eighth of
`maxWalBytes` waits. At an eighth, 128 KiB by default, the tail costs an open about 0.7 ms by the
rate above, which is what the first read of the flushed run costs: below it a flush saves nothing
a first screen would see, and a slow typist would get a run per pause.

**Not measured.** The cost of the extra L0 runs to compaction over a long session, and a tail of
many small records, where the replay costs more per byte.
