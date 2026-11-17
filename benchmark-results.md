# Benchmark results, for the homepage update

Every number below comes from `docs/benchmarks.md` on branch `feat/bench-trim` (PR #293, the top of the stack #287 → #289 → #293). Each value is written exactly as it appears there. Full run files are under `docs/results/` on that branch.

## Rules for the homepage agent

1. **Work on `feat/bench-trim`, or on `main` after #287, #289 and #293 merge.** On today's `main`, `docs/benchmarks.md` has none of the goal, typing or live-query numbers. The homepage would fail its check.
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

The task-tracker workspace (20,000 issues) written through TanStack DB, with four screens as live queries: a todo column, open issues with a label, a person's open issues, and the 50 latest issues. Then 870 sync batches land. Apple M2 Pro, medians of 3, load average 3.1 to 6.6. Run: `docs/results/2026-11-16T22-26-04-apple-m2-pro.md`.

| Measure | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| Opening the collections in a fresh tab | 184 ms | 99 ms | 11 ms | 61 ms | yes (on demand: 11 ms) |
| First answer: a project's todo column | 19.9 ms | 20.0 ms | 23.4 ms | 41.3 ms | caveat (even with IndexedDB) |
| First answer: open issues with a label | 37.2 ms | 38.8 ms | 24.1 ms | 44.1 ms | yes (on demand) |
| First answer: a person's open issues | 37.6 ms | 39.8 ms | 6.4 ms | 9.6 ms | yes (on demand) |
| First answer: the 50 latest issues | 3.3 ms | 3.3 ms | 9.0 ms | 9.0 ms | no (on demand slower) |
| A sync batch, no screen open | 4.0 ms | 1.7 ms | 1.7 ms | 32 ms | yes |
| A sync batch, four screens open | 7.4 ms | 5.5 ms | 5.2 ms | 127 ms | yes |
| Frames dropped over 435 batches, screens open | 9 | 11 | 7 | 260 | yes (vs SQLite) |

Takeaway, using only values from the table: with four live screens open, a sync batch takes 5.5 ms on docstore against 127 ms on SQLite, and 7 frames drop on demand against 260.

## 5. Goal benchmarks: a task tracker's screens (new)

20,000 issues, 43,000 comments, 120 people, 24 projects and 30 labels, built from a sync history. Each library answers each screen with its own query API; every answer is checked against an oracle. Apple M2 Pro, medians of 3, load average 1.1 to 4.9. Run: `docs/results/2026-11-16T19-30-45-apple-m2-pro.md`. Cells are cold / warm in ms: cold is the first call in a fresh tab, warm repeats it.

| Goal | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Issues per status in a project | 10.6 / 8.0 | 1.6 / 0.26 | 5.6 / 0.41 | caveat (SQLite faster) |
| First 50 todo issues, with assignee and label names | 2.5 / 1.0 | 2.9 / 0.50 | 7.1 / 0.42 | warm only |
| The column a sprint close just emptied | 10.2 / 6.2 | 2.0 / 0.29 | 6.2 / 1.3 | no |
| Rows at 90% of a project's list | 18.3 / 12.4 | 2.2 / 0.43 | 12.6 / 1.9 | no (no offset in docstore) |
| An issue with its comments and their authors | 1.5 / 0.43 | 1.9 / 0.36 | 5.4 / 0.14 | warm only |
| First 50 open issues by priority, with comment counts | 4.7 / 2.9 | 6.8 / 2.3 | 13.4 / 1.3 | warm only |
| First 50 open issues with a label | 7.0 / 4.7 | 8.3 / 2.9 | 6.4 / 0.35 | yes |
| First 50 open issues assigned to a person | 2.4 / 1.2 | 4.0 / 0.74 | 9.6 / 0.48 | warm only |
| The 50 most recently updated issues | 2.1 / 1.2 | 2.5 / 0.70 | 3.6 / 0.63 | warm only |
| Open issues per person, top 10 | 11.9 / 9.1 | 3.2 / 0.50 | 14.8 / 4.3 | no (no group-by in docstore) |
| First 20 issues whose title contains a word | 6.2 / 5.8 | 2.4 / 0.77 | 6.3 / 0.27 | warm only |
| Opening the store in a fresh tab (ms) | 2.1 | 29 | 17 | no |

Summary sentence you may quote, since it is in `docs/benchmarks.md`: "Warm, docstore answers 7 of the 11 goals fastest". Cold, docstore is the slowest on most goals, so don't claim cold read speed.

## 6. Writing the tracker's history (new)

Same run as section 5.

| Measure | Dexie | SQLite on OPFS | docstore (opfs-lsm) | Headline |
| --- | ---: | ---: | ---: | --- |
| Import, 44 batches of 1,000 rows | 2.9 s | 1.0 s | 0.80 s | yes |
| Sync, 875 batches of 50 changes | 5.8 s | 11.7 s | 3.2 s | yes |
| One edit | 0.40 ms | 1.1 ms | 0.61 ms | no (Dexie faster) |
| Sprint close, 1,027 issues in one batch | 155 ms | 85 ms | 61 ms | yes |
| Re-reading the 50 latest issues during the sync (separate run, load average 4 to 5) | 1.5 ms | 0.58 ms | 0.82 ms | no (SQLite faster) |

## 7. Typing, then reopening a document (new, partly before open fixes)

The editing trace: 25,700 keystrokes written, then the last 300 typed at one per 16 ms frame, then cold opens in a fresh tab before and after kv settles. Apple M2 Pro, medians of 3 (6 for Yjs on kv), load average 2 to 5.

| Measure | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Headline |
| --- | ---: | ---: | ---: | ---: | --- |
| One keystroke, with its persistence | 0.28 ms | 0.36 ms | 0.58 ms | 0.58 ms | caveat (even) |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | yes ("no dropped frames while typing") |
| Cold open before the settle | 7.2 ms | 16 ms | 58 ms | 64 ms | no |
| Cold open after the settle | 7.5 ms | 52 ms | 58 ms | 65 ms | no: before the fix in #294, which brings this open to 16 to 18 ms |

One Yjs run in six took 17 s per cold open, a bug that #292 fixes. Don't mention it on the homepage.

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
- TanStack DB: 6.7× faster bulk inserts than its IndexedDB option. With four live screens, a sync batch takes 5.5 ms against 127 ms on SQLite.
- Task tracker: a sync of 875 batches takes 3.2 s on docstore, against 5.8 s on Dexie and 11.7 s on SQLite. Warm, docstore answers 7 of the 11 goals fastest.
- No dropped frames while typing into a Yjs or Automerge document at one key per frame.
- 18.8 kB at import, 47.6 kB after open.
