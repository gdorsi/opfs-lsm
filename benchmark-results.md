# Benchmark results, for the homepage update

Every number below comes from `docs/benchmarks.md` on `main`. Each value is written exactly as it appears there. Full run files are under `docs/results/`. Every table was re-measured on 2026-11-17 on an Apple M5 Max, after #311, #312, #313 and #315.

## Rules for the homepage agent

1. **Work on `main` after #293 merges.** Before that, `docs/benchmarks.md` on `main` has older numbers, and the homepage would fail its check.
2. **The site check:** every number in `site/index.md`, in the frontmatter values and in the prose (link targets excluded), must appear verbatim in `docs/benchmarks.md`. Run it with:
   `node -e 'import("./site/.vitepress/links.ts").then(m=>{m.checkSite();console.log("ok")})'`
3. **Copy numbers exactly as the tables show them** ("4.8×", "127 ms", "3.2 s"). Don't compute new ratios. A derived figure such as "1.8× faster sync than Dexie" appears nowhere in `docs/benchmarks.md`, so it fails the check. Quote the two values instead ("3.2 s vs 5.8 s").
4. **Only rows marked "yes" in the Headline column are safe to feature.** "Caveat" rows need their note next to them. "No" rows are true but must not be headlined: they are losses, or values from before an open fix.
5. **Current homepage numbers** (`site/index.md`): `19.5 kB` (bundle), `4.2×` (Yjs cold loads), `100,000` (demo tracker). #289 removed the "Measured on real apps" card and its `apps:` frontmatter. Nothing has replaced it yet, and that is the slot to fill.

## 1. Storage calls: kv vs IndexedDB

Apple M5 Max, Chrome 157, medians of 10 runs (21 for the `kv/fillrandom` rows), load average 2.4 to 6.4, 100,000 entries (16-byte keys, 100-byte values). Run: `docs/results/2026-11-17T19-07-52-apple-m5-max.md`.

| Measure | IndexedDB | kv | kv vs IndexedDB | Headline |
| --- | ---: | ---: | ---: | --- |
| Random writes, batches of 1,000 | 42.0k ops/s | 494k ops/s | 12× | yes |
| Random point reads | 21.9k ops/s | 592k ops/s | 27× | yes |
| Reads of missing keys | 24.4k ops/s | 1.89M ops/s | 78× | yes |
| Full ordered scan | 678k ops/s | 1.38M ops/s | 2.0× | yes |
| Seeks of 100 keys | 5.1k ops/s | 19.5k ops/s | 3.8× | yes |
| Single put, awaited one at a time | 14.7k ops/s | 13.0k ops/s | 0.9× | no (kv slower) |
| Read-modify-write in one transaction | 0.12 ms | 0.16 ms | 0.7× | no (kv slower) |
| Cold open | 0.9 ms | 6.7 ms | 0.1× | no (kv slower) |

## 2. Framework adapters vs each framework's IndexedDB option

Apple M5 Max, size `small`, medians of 5 runs, load average 1.9 to 4.5. Run: `docs/results/2026-11-17T19-45-25-apple-m5-max.md`. IndexedDB options: TanStack DB `indexedDBCollectionOptions`, y-indexeddb, automerge-repo `IndexedDBStorageAdapter`, `@nkzw/fate-indexeddb`.

| Framework | Measure | IndexedDB option | opfs-lsm | Ratio | Headline |
| --- | --- | ---: | ---: | ---: | --- |
| TanStack DB | Cold load of 91,000 rows | 137k rows/s | 451k rows/s | 3.3× | yes |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 19.7k rows/s | 131k rows/s | 6.7× | yes |
| TanStack DB | Serial insert, one row per transaction | 6.9k rows/s | 5.7k rows/s | 0.8× | no (opfs-lsm slower) |
| Yjs | Cold load of 500 notes | 3.0k notes/s | 12.7k notes/s | 4.2× | yes (already on the homepage) |
| Yjs | Editing trace, one update per keystroke | 2.1k edits/s | 36.0k edits/s | 17× | yes |
| Automerge | Cold load of 500 notes | 2.0k notes/s | 2.8k notes/s | 1.4× | yes |
| Automerge | Write 500 notes | 875 notes/s | 922 notes/s | 1.1× | caveat (about even) |
| fate | Cold load of 100 lists of 100 records | 2.1k records/s | 4.1k records/s | 2.0× | yes |

## 3. TanStack DB on demand vs SQLite

TanStack DB's SQLite persistence (wa-sqlite on OPFS in a worker) against opfs-lsm, 100,000 rows each. Apple M5 Max, medians of 5 runs, load average 4.0 to 4.8. Run: `docs/results/2026-11-17T20-16-52-apple-m5-max.md`.

| Measure | SQLite | opfs-lsm | Ratio | Headline |
| --- | ---: | ---: | ---: | --- |
| Cold open | 37.7 ms | 7.2 ms | 5.2× | yes |
| First query after a cold open, 6,250 rows | 65.6 ms | 63.1 ms | 1.0× | no (even) |
| Warm query of one owner, 6,250 rows | 132k rows/s | 205k rows/s | 1.6× | yes |
| 10 rows by id | 2.2k queries/s | 5.3k queries/s | 2.4× | yes |

## 4. TanStack DB live queries (new)

The task-tracker workspace written through TanStack DB, with four screens as live queries: a todo column, open issues with a label, a person's open issues, and the 50 latest issues. The screens open one after another in a fresh tab, so only the first starts cold. Then 851 sync batches land. Apple M5 Max, means per call or batch, medians of 3 runs, load average 5.5 to 8.5. Run: `docs/results/2026-11-17T20-29-34-apple-m5-max.md`.

| Measure | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| Opening the collections in a fresh tab | 139 ms | 70 ms | 8.9 ms | 48 ms | yes (on demand: 8.9 ms) |
| First answer: a project's todo column | 18.9 ms | 18.1 ms | 18.7 ms | 31.8 ms | caveat (even with IndexedDB) |
| First answer: open issues with a label | 29.0 ms | 28.4 ms | 11.9 ms | 8.4 ms | no (SQLite faster) |
| First answer: a person's open issues | 29.3 ms | 28.2 ms | 5.2 ms | 6.8 ms | yes (on demand) |
| First answer: the 50 latest issues | 2.5 ms | 2.4 ms | 6.7 ms | 7.7 ms | no (on demand slower than eager) |
| A sync batch, no screen open | 3.1 ms | 1.2 ms | 1.3 ms | 23 ms | yes |
| A sync batch, four screens open | 6.5 ms | 3.8 ms | 3.5 ms | 85 ms | yes |
| Frames dropped over 426 batches, screens open | 9 | 7 | 0 | 81 | yes |

Takeaway, using only values from the table: with four live screens open, a sync batch takes 3.8 ms on docstore against 85 ms on SQLite, and no frame drops on demand against 81 on SQLite.

## 5. Goal benchmarks: a task tracker's screens (new)

20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels, built from a sync history. Each library answers each screen with its own query API, and every answer is checked against an oracle. Apple M5 Max, medians of 3 runs, load average 6.2 to 7.4. Run: `docs/results/2026-11-17T20-27-42-apple-m5-max.md`. Cells are cold / warm in ms: cold is the first call in a fresh tab, warm repeats it.

| Goal | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Issues per status in a project | 5.4 / 2.4 | 4.0 / 0.14 | 2.7 / 0.17 | caveat (fastest cold, SQLite faster warm) |
| First 50 todo issues, with assignee and label names | 2.3 / 0.95 | 5.2 / 0.41 | 7.2 / 0.32 | warm only |
| The column a sprint close just emptied | 8.4 / 5.1 | 4.3 / 0.24 | 4.3 / 0.91 | no (SQLite faster warm) |
| Rows at 90% of a project's list | 12.9 / 7.6 | 4.5 / 0.31 | 9.4 / 0.96 | no (no offset in docstore) |
| An issue with its comments and their authors | 1.4 / 0.34 | 4.5 / 0.25 | 4.7 / 0.092 | warm only |
| First 50 open issues by priority, with comment counts | 5.4 / 2.1 | 7.0 / 1.1 | 9.9 / 0.70 | warm only |
| First 50 open issues with a label | 6.9 / 3.5 | 7.0 / 1.3 | 4.9 / 0.16 | yes (fastest cold and warm) |
| First 50 open issues assigned to a person | 2.4 / 0.80 | 5.6 / 0.44 | 8.4 / 0.28 | warm only |
| The 50 most recently updated issues | 2.0 / 1.3 | 5.1 / 0.68 | 3.4 / 0.39 | warm only |
| Open issues per person, top 10 | 11.4 / 6.1 | 5.1 / 0.29 | 3.6 / 0.55 | caveat (fastest cold, SQLite faster warm) |
| First 20 issues whose title contains a word | 8.8 / 5.2 | 6.2 / 0.74 | 6.5 / 0.18 | warm only |
| Opening the store in a fresh tab (ms) | 1.7 | 22 | 13 | no (Dexie faster) |

Summary sentence you may quote, since it is in `docs/benchmarks.md`: "Warm, docstore answers 7 of the 11 goals fastest". Cold, docstore is the slowest on 4 of the 11, so don't claim cold read speed.

## 6. Writing the tracker's history (new)

Same run as section 5.

| Measure | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Import, 47 batches of up to 1,000 rows | 2.4 s | 0.92 s | 0.62 s | yes |
| Sync, 851 batches of about 50 changes | 4.8 s | 10.9 s | 2.5 s | yes |
| One edit | 0.33 ms | 3.2 ms | 0.36 ms | no (Dexie faster) |
| Sprint close, 1,054 issues in one batch | 114 ms | 72 ms | 50 ms | yes |
| Re-reading the 50 latest issues after every 10th sync batch | 1.3 ms | 0.47 ms | 0.56 ms | no (SQLite faster) |

SQLite's commits wait for the disk (its default), where Dexie and docstore commit with Chrome's relaxed durability. Mention it next to any write comparison with SQLite.

## 7. Typing, then reopening a document (new)

The editing trace: 25,700 keystrokes written, then the last 300 typed at one per 60 Hz frame, then cold opens in a fresh tab before and after kv settles. Apple M5 Max, medians of 5 runs, load average 1.9 to 3.8. Run: `docs/results/2026-11-17T19-45-25-apple-m5-max.md`.

| Measure | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| One keystroke, with its persistence | 0.10 ms | 0.15 ms | 0.28 ms | 0.29 ms | no (the IndexedDB options are a bit faster) |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | yes ("no dropped frames while typing") |
| Cold open before the settle | 5.4 ms | 12 ms | 42 ms | 47 ms | no (y-indexeddb faster) |
| Cold open after the settle | 5.3 ms | 12 ms | 43 ms | 48 ms | no (y-indexeddb faster) |

automerge-repo saves a document at most every 100 ms, so most Automerge keystrokes write nothing.

## 8. Bundle size

| | gzip | raw | loaded | Headline |
| --- | ---: | ---: | --- | --- |
| Main-thread JS | 19.5 kB | 57.4 kB | at import | yes (already on the homepage) |
| SharedWorker chunk | 13.4 kB | 40.7 kB | on the first `openDb` | |
| wasm engine | 16.6 kB | 36.3 kB | on the first `openDb` | |
| Total after open | 49.5 kB | 134.4 kB | | yes |

For comparison: Dexie is 31.4 kB gzip. `y-indexeddb` adds 1.2 kB on top of Yjs.

## Strongest claims, all verbatim-safe

- 78× faster reads of missing keys than IndexedDB, 27× faster point reads, 12× faster random writes.
- Yjs: 17× faster editing-trace persistence and 4.2× faster cold loads than y-indexeddb.
- TanStack DB: 6.7× faster bulk inserts than its IndexedDB option. With four live screens, a sync batch takes 3.8 ms against 85 ms on SQLite.
- Task tracker: a sync of 851 batches takes 2.5 s on docstore, against 4.8 s on Dexie and 10.9 s on SQLite. Warm, docstore answers 7 of the 11 goals fastest.
- No dropped frames while typing into a Yjs or Automerge document at one key per frame.
- 19.5 kB at import, 49.5 kB after open.
