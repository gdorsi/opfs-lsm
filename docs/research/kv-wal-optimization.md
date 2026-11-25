# Faster WAL reads and a 1 MiB ingest limit

Status: shipped. Ranged `getAll` reads, byte rows and the 1 MiB `maxWalBytes` default are in the
code, described in design.md's [WAL records](../design.md#wal-records),
[Reading the tail](../design.md#reading-the-tail) and [Trigger](../design.md#trigger). Since
2026-11-23 a tail read uses ranges of 100 seqs, not 25,000.

Date: 2026-11-06 to 2026-11-08. Headless Chrome 156, macOS, yjs bench at `DOCS=5000` (250,000 WAL
rows).

Question: in the yjs load bench, kv with auto-ingest off spent about 80% of its
open in reading the IndexedDB WAL. Opening replayed the whole uningested WAL
into a fresh memtable, on the tab's main thread, every `openDb`. At 250,000 WAL
rows the ~740 ms open split into ~680 ms reading 250k rows and ~50 ms replaying
them.

## Findings that drove it

- **The floor is per row, not per byte.** 250k rows cost 595-670 ms to read;
  the same 30 MB as 250 packed rows took 31 ms. Chromium streams `getAll`
  results in 1,000-row chunks (`kIDBGetAllChunkSize`), so the old
  `getAllKeys` + `getAll` path was 500 mojo messages per open.
- **`getAllRecords()` is a trap.** It returns keys and values in one call and
  looked 45% faster, but Chrome deserializes each value the first time
  `.value` is read: measured inside the real read path, its total cost
  equalled the old path's (378-413 ms read, ~255 ms decode). Only the parallel
  ranged `getAll` is a real gain.
- The memtable replay itself is ~50 ms; a bulk build would save ~25 ms. Not
  taken; too small next to the row cost.

## What shipped, with the numbers

| read path (250k rows) | open cold / warm (ms) |
|---|---|
| `getAllKeys` + `getAll`, object rows | 847 / 834 |
| ranged `getAll`, object rows | 524 / 483 |
| ranged `getAll`, byte rows (shipped) | **351 / 353** |

- **Ranged `getAll`.** Seqs are gapless above `ingestedThrough`, so a value's
  position gives its seq and the `getAllKeys` pass goes away. The readers
  fetched `(ingestedThrough, head]` in 25,000-seq ranges, all in flight in one
  transaction; a short range throws `wal gap`.
- **Byte rows.** One `ArrayBuffer` per batch (type byte, u32 key length, key,
  u32 value length, value); decode hands out `subarray` views. Nothing decoded
  from the WAL crosses `postMessage`, so the views keep no extra memory alive.
  Rows in the old object format throw `corrupt wal row: not bytes`.
- **`maxWalBytes` 4 MiB → 1 MiB.** Open 71/91 → 44/39 ms, all 243/266 →
  231/219 ms, write time flat (48.1 → 49.9 s for 50k docs). 256 KiB saved
  nothing more (39/25 ms) for four times the ingests and L0 compactions, so
  1 MiB is the default.

## Rejected

- **On-demand WAL reads by key.** Every `get`/`range` miss becomes an
  IndexedDB round trip, and the memtable stops being an exact WAL prefix, so
  view pins would have to hold IndexedDB transactions.
- **Replay in the SharedWorker, shipping packed memtable images to tabs.** A
  second in-memory LSM layer. Ingesting to SST already bounds open: kv-sst
  opens in 18-39 ms with nothing in the WAL.
- **Snapshotting the memtable.** Ingest under another name; the atomicity
  problem is the one ingest's transaction already solves.
- **Replay or memtable in wasm.** At most -50 ms of the span; IDB and
  structured clone dominate. May revisit if decode of packed groups ever
  dominates.

## Chromium facts kept

- `getAll` streams in 1,000-row chunks; `kIDBWrapThreshold` is 65536, so
  values over 64 KiB are stored as blobs with Snappy compression on LevelDB,
  and both are skipped on the SQLite backend (shipping in Chrome 150 for new
  stores; expect CPU, memory and runtime shifts). The blob wrapping exists
  because large values slowed LevelDB compaction.
- `getAllRecords()` is Chrome 141+ and MDN marks it limited availability; it
  needs a feature check. The fallback that shipped is the ranged `getAll`.
- The per-row estimates assume this bench's row shape (~116 op bytes/row).
  Smaller rows mean more rows per MiB, which is an argument for byte rows:
  open cost now tracks bytes rather than rows.

## Sources

- W3C Indexed Database API 3.0, https://w3c.github.io/IndexedDB/
- Chromium `indexeddb.mojom`,
  https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom
- Chromium `idb_value_wrapping.cc`,
  https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/indexeddb/idb_value_wrapping.cc
- Original value-wrapping change, https://codereview.chromium.org/2822453003/
- blink-dev PSA "IndexedDB: SQLite backend",
  https://groups.google.com/a/chromium.org/g/blink-dev/c/jS0khnC5IWA
- "New in Chrome 141": `getAllRecords()`,
  https://developer.chrome.com/blog/new-in-chrome-141
- MDN `IDBObjectStore.getAllRecords()`,
  https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAllRecords
- WHATWG HTML structured serialization and BroadcastChannel,
  https://html.spec.whatwg.org/multipage/structured-data.html
- WHATWG File System: `createSyncAccessHandle()` is `[Exposed=DedicatedWorker]`,
  so a synchronous OPFS WAL is not available to a SharedWorker or the main
  thread, https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle
