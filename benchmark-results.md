# Benchmark results, for the homepage update

Every number below comes from `docs/benchmarks.md` on `main`, once #293 merges. Each value is written exactly as it appears there. Full run files are under `docs/results/`. The M2 Pro tables were re-measured on 2026-11-17, after the review fixes and the fixes in #292 and #294.

## Rules for the homepage agent

1. **Work on `main` after #293 merges.** Before that, `docs/benchmarks.md` on `main` has older numbers, and the homepage would fail its check.
2. **The site check:** every number in `site/index.md`, in the frontmatter values and in the prose (link targets excluded), must appear verbatim in `docs/benchmarks.md`. Run it with:
   `node -e 'import("./site/.vitepress/links.ts").then(m=>{m.checkSite();console.log("ok")})'`
3. **Copy numbers exactly as the tables show them** ("4.8×", "127 ms", "3.2 s"). Don't compute new ratios. A derived figure such as "1.8× faster sync than Dexie" appears nowhere in `docs/benchmarks.md`, so it fails the check. Quote the two values instead ("3.2 s vs 5.8 s").
4. **Only rows marked "yes" in the Headline column are safe to feature.** "Caveat" rows need their note next to them. "No" rows are true but must not be headlined: they are losses, or values from before an open fix.
5. **Current homepage numbers** (`site/index.md`): `18.8 kB` (bundle), `4.8×` (Yjs cold loads), `100,000` (demo tracker). #289 removed the "Measured on real apps" card and its `apps:` frontmatter. Nothing has replaced it yet, and that is the slot to fill.

## 1. Storage calls: kv vs IndexedDB

Apple M5 Max, Chrome 157, medians of 10 runs, 100,000 entries (16-byte keys, 100-byte values). The run files were not kept.

| Measure | IndexedDB | kv | kv vs IndexedDB | Headline |
| --- | ---: | ---: | ---: | --- |
| Random writes, batches of 1,000 | 30.2k ops/s | 432k ops/s | 14× | yes |
| Random point reads | 16.4k ops/s | 488k ops/s | 30× | yes |
| Reads of missing keys | 17.8k ops/s | 1.64M ops/s | 92× | yes |
| Full ordered scan | 604k ops/s | 1.03M ops/s | 1.7× | yes |
| Single put, awaited one at a time | 9.1k ops/s | 7.4k ops/s | 0.8× | no (kv slower) |
| Cold open | 1.2 ms | 7.8 ms | 0.2× | no (kv slower) |

## 2. Framework adapters vs each framework's IndexedDB option

Size `small`. The run files were not kept. IndexedDB options: TanStack DB `indexedDBCollectionOptions`, y-indexeddb, automerge-repo `IndexedDBStorageAdapter`, `@nkzw/fate-indexeddb`.

| Framework | Measure | IndexedDB option | opfs-lsm | Ratio | Headline |
| --- | --- | ---: | ---: | ---: | --- |
| TanStack DB | Cold load of 91,000 rows | 112k rows/s | 176k rows/s | 1.6× | yes |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 17.2k rows/s | 115k rows/s | 6.7× | yes |
| TanStack DB | Serial insert, one row per transaction | 4.7k rows/s | 2.5k rows/s | 0.5× | no (opfs-lsm slower) |
| Yjs | Cold load of 500 notes | 2.0k notes/s | 9.5k notes/s | 4.8× | yes (already on the homepage) |
| Yjs | Editing trace, one update per keystroke | 1.4k edits/s | 33.2k edits/s | 23× | yes |
| Automerge | Cold load of 500 notes | 1.1k notes/s | 2.2k notes/s | 2.0× | yes |
| Automerge | Write 500 notes | 743 notes/s | 821 notes/s | 1.1× | caveat (about even) |
| fate | Cold load of 100 lists of 100 records | 1.0k records/s | 3.4k records/s | 3.3× | yes |

## 3. TanStack DB on demand vs SQLite

TanStack DB's SQLite persistence (wa-sqlite on OPFS in a worker) against opfs-lsm, 100,000 rows each. Apple M2 Pro, medians of 5 runs. The run files were not kept.

| Measure | SQLite | opfs-lsm | Ratio | Headline |
| --- | ---: | ---: | ---: | --- |
| Cold open | 48.1 ms | 12.0 ms | 4.0× | yes |
| First query after a cold open, 6,250 rows | 88.1 ms | 88.1 ms | 1.0× | no (even) |
| Warm query of one owner, 6,250 rows | 90.7k rows/s | 131k rows/s | 1.4× | yes |
| 10 rows by id | 1.6k queries/s | 3.6k queries/s | 2.3× | yes |

## 4. TanStack DB live queries (new)

The task-tracker workspace written through TanStack DB, with four screens as live queries: a todo column, open issues with a label, a person's open issues, and the 50 latest issues. The screens open one after another in a fresh tab, so only the first starts cold. Then 851 sync batches land. Apple M2 Pro, means per call or batch, medians of 3 runs, load average 1.8 to 4.8. Run: `docs/results/2026-11-17T00-54-52-apple-m2-pro.md`.

| Measure | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| Opening the collections in a fresh tab | 180 ms | 93 ms | 9.6 ms | 57 ms | yes (on demand: 9.6 ms) |
| First answer: a project's todo column | 22.9 ms | 23.4 ms | 23.4 ms | 39.8 ms | caveat (even with IndexedDB) |
| First answer: open issues with a label | 33.8 ms | 35.2 ms | 13.0 ms | 10.3 ms | no (SQLite faster) |
| First answer: a person's open issues | 35.2 ms | 37.9 ms | 6.3 ms | 8.1 ms | yes (on demand) |
| First answer: the 50 latest issues | 3.5 ms | 3.4 ms | 8.8 ms | 9.4 ms | no (on demand slower than eager) |
| A sync batch, no screen open | 3.8 ms | 1.9 ms | 1.6 ms | 26 ms | yes |
| A sync batch, four screens open | 7.2 ms | 5.6 ms | 4.7 ms | 108 ms | yes |
| Frames dropped over 426 batches, screens open | 11 | 9 | 0 | 184 | yes |

Takeaway, using only values from the table: with four live screens open, a sync batch takes 5.6 ms on docstore against 108 ms on SQLite, and no frame drops on demand against 184 on SQLite.

## 5. Goal benchmarks: a task tracker's screens (new)

20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels, built from a sync history. Each library answers each screen with its own query API, and every answer is checked against an oracle. Apple M2 Pro, medians of 3 runs, load average 2.3 to 4.4. Run: `docs/results/2026-11-17T00-52-40-apple-m2-pro.md`. Cells are cold / warm in ms: cold is the first call in a fresh tab, warm repeats it.

| Goal | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Issues per status in a project | 5.7 / 3.3 | 5.3 / 0.18 | 5.3 / 0.30 | caveat (SQLite faster warm) |
| First 50 todo issues, with assignee and label names | 2.2 / 1.2 | 6.8 / 0.53 | 8.3 / 0.47 | warm only |
| The column a sprint close just emptied | 8.1 / 5.8 | 5.9 / 0.29 | 5.5 / 1.4 | no (SQLite faster warm) |
| Rows at 90% of a project's list | 14.8 / 9.5 | 5.9 / 0.38 | 12.0 / 1.3 | no (no offset in docstore) |
| An issue with its comments and their authors | 1.6 / 0.40 | 5.8 / 0.32 | 6.3 / 0.16 | warm only |
| First 50 open issues by priority, with comment counts | 5.4 / 2.7 | 8.7 / 1.4 | 16.3 / 1.4 | no (tie warm, slowest cold) |
| First 50 open issues with a label | 8.2 / 4.6 | 8.7 / 1.6 | 6.2 / 0.27 | yes (fastest cold and warm) |
| First 50 open issues assigned to a person | 2.2 / 1.1 | 7.3 / 0.50 | 9.0 / 0.42 | warm only |
| The 50 most recently updated issues | 2.2 / 1.3 | 6.5 / 0.81 | 3.8 / 0.63 | warm only |
| Open issues per person, top 10 | 10.7 / 7.3 | 6.8 / 0.36 | 16.4 / 4.5 | no (no group-by in docstore) |
| First 20 issues whose title contains a word | 11.8 / 7.2 | 7.7 / 0.87 | 7.5 / 0.30 | yes (fastest cold and warm) |
| Opening the store in a fresh tab (ms) | 2.2 | 24 | 18 | no |

Summary sentence you may quote, since it is in `docs/benchmarks.md`: "Warm, docstore answers 7 of the 11 goals fastest". Cold, docstore is the slowest on 5 of the 11, so don't claim cold read speed.

## 6. Writing the tracker's history (new)

Same run as section 5.

| Measure | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Import, 47 batches of up to 1,000 rows | 2.8 s | 1.0 s | 0.85 s | yes |
| Sync, 851 batches of about 50 changes | 5.6 s | 11.3 s | 3.3 s | yes |
| One edit | 0.41 ms | 1.1 ms | 0.73 ms | no (Dexie faster) |
| Sprint close, 1,054 issues in one batch | 156 ms | 88 ms | 81 ms | yes |
| Re-reading the 50 latest issues after every 10th sync batch | 1.4 ms | 0.54 ms | 0.69 ms | no (SQLite faster) |

SQLite's commits wait for the disk (its default), where Dexie and docstore commit with Chrome's relaxed durability. Mention it next to any write comparison with SQLite.

## 7. Typing, then reopening a document (new)

The editing trace: 25,700 keystrokes written, then the last 300 typed at one per 60 Hz frame, then cold opens in a fresh tab before and after kv settles. Apple M2 Pro, medians of 3 runs, load average 1.9 to 2.8. Run: `docs/results/2026-11-17T00-58-58-apple-m2-pro.md`.

| Measure | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| One keystroke, with its persistence | 0.23 ms | 0.28 ms | 0.56 ms | 0.61 ms | no (the IndexedDB options are a bit faster) |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | yes ("no dropped frames while typing") |
| Cold open before the settle | 7.2 ms | 16 ms | 57 ms | 62 ms | no (y-indexeddb faster) |
| Cold open after the settle | 7.3 ms | 22 ms | 56 ms | 64 ms | no (y-indexeddb faster) |

automerge-repo saves a document at most every 100 ms, so most Automerge keystrokes write nothing.

## 8. Bundle size

| | gzip | raw | loaded | Headline |
| --- | ---: | ---: | --- | --- |
| Main-thread JS | 18.8 kB | 55.0 kB | at import | yes (already on the homepage) |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` | |
| wasm engine | 16.6 kB | 36.4 kB | on the first `openDb` | |
| Total after open | 47.6 kB | 127.5 kB | | yes |

For comparison: Dexie is 31.4 kB gzip. `y-indexeddb` adds 1.2 kB on top of Yjs.

## Strongest claims, all verbatim-safe

- 92× faster reads of missing keys than IndexedDB, 30× faster point reads, 14× faster random writes.
- Yjs: 23× faster editing-trace persistence and 4.8× faster cold loads than y-indexeddb.
- TanStack DB: 6.7× faster bulk inserts than its IndexedDB option. With four live screens, a sync batch takes 5.6 ms against 108 ms on SQLite.
- Task tracker: a sync of 851 batches takes 3.3 s on docstore, against 5.6 s on Dexie and 11.3 s on SQLite. Warm, docstore answers 7 of the 11 goals fastest.
- No dropped frames while typing into a Yjs or Automerge document at one key per frame.
- 18.8 kB at import, 47.6 kB after open.
