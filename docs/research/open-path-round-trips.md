# Round trips in a cold open

Date: 2026-11-11. Chrome 157 headless, macOS arm64, Apple M5 Max. The machine ran other work
during every measurement, and the same build opened in 3.4 to 6.8 ms from one run to the next.
The comparisons below rotate their variants inside one run and report paired differences.

Status: five small changes are implemented. Two larger options are not.

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
