# Making the `kv-wal` read path faster

Question: in the Yjs load bench, `kv-wal` (every write still in the IndexedDB WAL) spends about
80% of its time in `openDb`. Why, and what should change?

Status: recommendation 1 is implemented with parallel ranged `getAll` only. `getAllRecords`
did not help in the real read path; see [Follow-up: recommendation 1 in place](#follow-up-recommendation-1-in-place).
The research itself changed no source code. Everything below was measured on 2026-11-06,
on macOS with headless Chrome 156.0.8078.80, unless it is marked **(inferred)**.

## Summary and ranked recommendation

Opening the database replays the whole uningested WAL into a fresh memtable, on the tab's main
thread, every time `openDb` is called. The SharedWorker does not replay. At 250,000 WAL rows the
open trace splits the ~740 ms open into:

- **~680 ms `wal-read`**: one IndexedDB transaction doing `getAllKeys` + `getAll`, then decoding
- **~50 ms `memtable`**: 250k sorted inserts
- **~10 ms** of everything else

Almost all of the cost is per IndexedDB row. Bytes cost little: reading the same 30 MB as 250
packed rows takes 31 ms, against 595 ms as 250,000 rows.

1. **Read the WAL with `getAllRecords()`, or with `getAll()` over key-range chunks issued in
   parallel, instead of `getAllKeys()` + `getAll()`.** Measured IDB time drops from ~560 ms to
   ~305 ms at 250k rows, about 45% of `wal-read`. The change is a few lines in
   `readRecords` (`packages/kv/src/idb/wal.ts:106`), with no format or protocol change and no
   effect on consistency. Feature-detect `getAllRecords`, since MDN marks it limited
   availability, and fall back to the parallel chunks, which use only standard API and measured
   the same (~313 ms). This is the cheapest win. **Correction after implementing it:** the
   `getAllRecords` saving moves into decode, because Chrome deserializes each record's value
   when `.value` is first read. Only the parallel `getAll` ranges are a real gain; see the
   follow-up section.
2. **Store fewer, larger WAL rows.** Coalesce the puts a tab issues in the same tick into one
   WAL record (group commit), and encode a record as one packed `ArrayBuffer` instead of an array
   of `{type, key, value}` objects. Reading 250k records packed 1,000 per row took 31 ms in
   total (12 ms IDB + 19 ms decode), against 595 ms for the current layout: about 19× faster.
   At 400 per row it took 50 ms. Real group sizes depend on how many writes a tab has in flight,
   so the gain in the app is smaller than this ceiling **(inferred)**. Writes speed up too,
   because fewer transactions commit. This is an architectural change, so it fits the design
   principles better than a cache does. It changes the WAL record format, which the prototype
   allows.
3. **Treat `kv-wal` as a worst case, not a configuration, and bench the default policy.** The
   default `maxWalBytes` is 4 MiB (`packages/kv/src/ingest-policy.ts:16-18`). The bench sets it
   to `Number.MAX_SAFE_INTEGER` (`examples/yjs/bench/main.ts:60,148`), which lets the WAL grow
   to 22 MB / 250k rows. Open cost is linear at ~2.7 µs per row, so a WAL held near 4 MiB of
   ops (~36k rows of this shape) would cost about 100 ms to open, and about 50 ms after
   recommendation 1 **(inferred from the per-row rate, not measured)**. The policy is the real
   bound on open time. If open time matters more than ingest churn, a lower default is the
   simplest lever.

Lower value, in order: build the memtable in bulk on open, with one sort instead of 250k
inserts (~50 → ~23 ms). Reject the rest, with reasons in the table below: on-demand WAL reads by
key, moving replay into wasm, replay in the SharedWorker shipped to tabs, and snapshotting the
memtable.

## Findings: what `openDb` does with the WAL

Every step below runs **in the tab**, once per `openDb` call:

| Step | Code | Notes |
|---|---|---|
| Open OPFS dir, construct `SharedWorker`, port ingest client | `packages/kv/src/db.ts:286-300` | ~1–11 ms (`opfs` span) |
| Open IDB `opfs-lsm-wal/<name>` | `db.ts:306-308`, `idb/wal.ts:69-88` | ~0.2–1.5 ms |
| Read the recorded generation, seed it from the manifest if missing | `db.ts:309-316` | <1 ms once recorded |
| `new DbImpl(...)`, with a **new, empty `Memtable`** and a `BroadcastChannel` | `db.ts:318-326`, `db.ts:390`, `db.ts:417-421` | A memtable belongs to one `Db`. Nothing is shared between two `openDb` calls on the same page, which is why "warm" costs the same as cold. |
| `await db.sync()` → `syncOnce` → `wal.tail(appliedThrough = 0)` | `db.ts:328`, `db.ts:534-562`, `idb/wal.ts:162-173` | One readonly transaction over `wal` + `meta` |
| `readTail`: 3 meta `get`s and `readRecords` over `lowerBound(0, open)`, in parallel | `idb/wal.ts:126-140` | Reads every row, then filters `seq > ingestedThrough` |
| `readRecords`: `getAllKeys(range)` and `getAll(range)` in parallel, then `decodeOps` per row | `idb/wal.ts:106-124`, `idb/wal.ts:52-67` | Each row is `[{type, key: ArrayBuffer, value: ArrayBuffer}]` (`idb/wal.ts:44-50`): 4 JS objects to deserialize per row, plus 3 more created by the decode. |
| Load the SST generation if it differs | `db.ts:545-547` | 0 ms for `kv-wal`, which is generation 0 |
| `catchUp`: `mem.apply(record)` for every record, in seq order | `db.ts:485-509`, `store/memtable.ts:106-140` | Binary search on chunk firsts, then splice into a chunk of ≤1024 rows |
| `ingest.watch(name, policy)`, fire-and-forget | `db.ts:330`, `host/engine-host.ts:118-142` | The **SharedWorker** reads only the `pendingBytes` meta counter (`idb/wal.ts:283-312`). It does not list or replay the WAL on open. Since commit `156579d`, open does not wait for it. |

So the replay is per tab, per `openDb`, on that tab's main thread. The SharedWorker reads the
WAL in full only when it ingests (`host/ingest.ts:30-31` → `listUningested`,
`idb/wal.ts:315-327`, the same `getAll` path). Recommendations 1 and 2 speed up ingest as well.

BroadcastChannel is not on the open path. The constructor creates it, and it carries appends
after open (`db.ts:424-438`). Structured clone of `getAll` results and the per-row IPC are the
cost.

### Why "warm" is barely cheaper

The bench's warm pass is a second `openDb` on the same page (`examples/yjs/bench/main.ts:226-251`).
It builds a new `DbImpl`, and so a new memtable, and re-reads all 250k rows. The only savings
are wasm init and the first OPFS/IDB opens (~10 ms). The trace confirms it: warm `wal-read` is
684–698 ms against 666–683 ms cold.

## Measurements

### 1. The open trace in the real bench

`HarnessOpenOptions.trace` (`db.ts:96-100`) collects `OpenSpan`s (`db.ts:103-128`). The phases
are `opfs`, `worker-ctor`, `idb-open`, `generation`, `wal-read` (the whole `tail()` transaction,
IDB plus decode, `db.ts:536-542`), `sst`, `memtable` (`catchUp`, `db.ts:549-558`), `sync`,
`open`, and asynchronously `wasm` and `host-scan`. The public `openDb` passes its options
straight to `openDbWith` (`db.ts:243-245`), so the bench can pass `trace` with the same cast it
already uses for `ingestPolicy`.

How it was measured: a **temporary edit** to the untracked `examples/yjs/bench/main.ts`. A copy
was saved first, and afterwards restored and checked by sha1 (`5865c75…`). The edit passed
`trace: lastTrace` in `openKv` and copied `lastTrace.spans` into each `LoadPass`. No kv source
was touched.

```sh
DOCS=5000 RUNS=2 BENCH_OUT=<scratch>/yjs-trace-5000.json \
  pnpm --filter @opfs-lsm/example-yjs bench:load
```

Result (50,000 docs × 5 updates = 250,000 WAL rows, 21.8 MB of update bytes):

| Shape / pass | open | wal-read (250k rows) | memtable | other | all |
|---|---|---|---|---|---|
| kv-wal run 0 cold | 746 | 683.4 | 50.6 | ~12 | 915 |
| kv-wal run 0 warm | 758 | 698.0 | 55.3 | ~5 | 948 |
| kv-wal run 1 cold | 733 | 666.2 | 50.2 | ~17 | 906 |
| kv-wal run 1 warm | 735 | 683.9 | 49.8 | ~2 | 925 |
| kv-sst (any) | 18–39 | 0.2–0.3 | 0 | `sst` 10–36 | 196–225 |

Medians (same run): kv-wal open 740 / 747 ms, all 911 / 936 ms. kv-sst all 211 / 201 ms.
y-indexeddb all 990 / 1048 ms. That matches the numbers in the brief.

`host-scan` never showed up in the spans, which were copied ~170 ms after open. Why was not
investigated. It is off the open path either way.

### 2. IndexedDB layout floor (scratch page, no kv code)

A standalone page wrote 250,000 rows shaped like the yjs WAL into a fresh Chrome profile: a
28-byte key, an 88-byte value, and autoIncrement keys. It wrote the same data in several
layouts, then timed reads. Each read used a fresh connection, and every variant ran 3 rounds.
The scripts are `exp.js` and `drive.mjs` in the session scratchpad. They are not in the repo.
The profile used the **LevelDB** backend (`*.indexeddb.leveldb` directories), so the SQLite
backend may differ (see Sources).

| Read | ms (3 rounds) | Notes |
|---|---|---|
| `getAllKeys` + `getAll`, then decode (**today's path**) | 595 / 669 / 571 | IDB 549–578, decode 18–75 |
| `getAll` alone | 492 / 493 / 480 | |
| `getAllKeys` alone | 79 / 82 / 81 | |
| **`getAllRecords()`** (keys + values) | **308 / 309 / 302** | Chrome 141+ |
| cursor | 744 / 764 / 738 | What the code did before `ea4b80c` |
| `getAll` in 25k-key ranges, sequential | 443 / 429 / 426 | First chunk at 44 ms |
| **`getAll` in 25k-key ranges, all issued at once** | **315 / 314 / 312** | Standard API, one transaction |
| One packed `ArrayBuffer` per row, `getAll` + decode | 461 / 453 / 466 | IDB ~400. Dropping the object graph helps only ~20%. |
| **1,000 records packed per row** (250 rows), `getAll` + decode | **31 / 34 / 34** | IDB 12, decode 19–22 |
| 400 records packed per row (625 rows) | 54 / 50 / 46 | IDB 29–34 |
| One 30.75 MB row | 43 / 39 / 42 | |
| `structuredClone` of the 250k decoded values, in-thread | 222–226 | An estimate of how much the object graph alone costs to deserialize |

What this shows:

- The floor is **per row, not per byte**. One packed buffer per row still costs ~1.6 µs per row
  in IDB. Chromium streams `getAll` results in 1,000-item chunks (`kIDBGetAllChunkSize`, see
  Sources), so 250k rows are 250 mojo messages per request. Today's path makes two requests
  (`getAllKeys` + `getAll`), so 500 messages.
- `getAllRecords()` returns keys and values in one request, and is faster than `getAll` alone.
  Parallel range chunks reach the same ~310 ms. Why one big `getAll` is slower than its chunks
  was not investigated. It may come from how the renderer accumulates one huge result
  **(inferred)**.
- Decode (`decodeOps`) is 20–75 ms and noisy because of GC. It is not the main cost.

### 3. Memtable replay (Node, same V8 code)

`<scratch>/memtable-bench.ts` imports `packages/kv/src/store/memtable.ts` directly and applies
250k records with yjs-bench keys, in the bench's interleaved write order (pool of 20 docs × 5
edits). It ran from `examples/yjs` with `./node_modules/.bin/tsx <scratch>/memtable-bench.ts`.

| Build | median of 5 |
|---|---|
| `Memtable.apply` × 250k (today) | 50.2 ms (matches the 50 ms browser `memtable` span) |
| Collect rows, one `sort` by key, cut into 512-row chunks | 23.4 ms (lower bound: no dedupe) |
| `Map<string,row>` keyed by a latin1 key string | 60.8 ms |

## Candidate optimizations

Effect is on `kv-wal` open at 250k rows (~740 ms) unless noted. "Measured" means the floor in
the experiments above, not a patched kv.

| # | Change | Expected effect | Cost | Fit with principles | Correctness risk |
|---|---|---|---|---|---|
| A | `getAllRecords()` (feature-detected) in `readRecords`, falling back to parallel ranged `getAll`. Seqs are gapless, so ranges are `bound(lo, lo+K-1)` up to `head`; read `head` first in the same transaction. | −250 ms of IDB time (560 → ~305), **measured floor**. Ingest's `listUningested` gets the same gain. | Small: ~20 lines in `idb/wal.ts` | Good: no format change, KISS | Low. Still one readonly transaction, so the snapshot is the same. Keep the gap check in `catchUp` (`db.ts:503-507`). |
| B | Group commit: coalesce `batch`/`put` calls issued in the same tick in one tab into one WAL record (one seq). `update` stays a singleton via `appendAfter`. | Rows ÷ coalescing factor. The factor is up to ~20 in this bench (pool of 20) **(inferred)**. Writes speed up too (today 250k puts = 50 s). | Medium: append queue in `DbImpl.batch`, broadcast carries the merged ops | Architectural, not a cache: good | Every coalesced caller acks on the same commit, and a failure rejects them all, which is the same failure mode as today. Validate each caller's ops (`checkBatch`) before merging, so one bad op cannot fail others. One seq now holds several callers' ops, applied in enqueue order. Read-your-writes still holds at ack (`landed`, `db.ts:569-573`). Batch limits (10k ops / 8 MiB) apply to the merged record. |
| C | Packed binary record encoding: one `ArrayBuffer` per record (`[type][klen][key][vlen][value]…`) instead of the object array; decode with `subarray` views. | Alone ~−20% of IDB time (measured 400 vs 490 ms). **With B, the 1000/row floor is 31 ms total** (measured). | Small–medium: `encodeOps`/`decodeOps` and `opsBytes` | Good | Memtable rows then hold views into a larger buffer: a single small value keeps its whole group buffer alive. That memory is retained until ingest **(inferred)**. Copy on `get` already happens (`db.ts:335-337`). |
| D | Lower or keep the default `maxWalBytes`, and bench the default instead of `NO_AUTO_INGEST`. | Open ∝ WAL rows (~2.7 µs/row today). 4 MiB ≈ 36k rows ≈ ~100 ms; 1 MiB ≈ ~25 ms **(inferred)**. | Trivial | Good: the existing architecture already bounds it | More ingests, and so more L0 runs and compaction (ingest of 250k took 2.2 s here). No consistency change. |
| E | Bulk-build the memtable when `catchUp` applies a tail into an empty memtable: sort, dedupe by last seq, chunk. | −25 ms (50 → ~23–25), measured lower bound | Small: a `Memtable.load(records)` path | Fine | Must keep "last seq wins" per key, and `appliedThrough` = last seq. A stable sort by key on records already in seq order gives that. |
| F | Reuse one memtable per page for every `openDb` of the same name, refcounted. | Warm open → ~0 replay. Only helps code that opens the same db twice on a page. | Small–medium | It is a new cache, so the principles say avoid it unless needed. Real apps open once. | A shared memtable means shared `sync`/close lifetimes, and pins must stay per view. Low value. |
| G | Lazy or on-demand WAL reads by key (an IDB index on op keys, or read the WAL on a memtable miss). | Open ~0, but every `get`/`range` miss becomes an IDB round trip (~0.1–1 ms) | Large: a multiEntry index slows every append | Breaks "reads touch no IndexedDB" (`db.ts:382-387`) and hurts read perf, the top principle | High: the memtable is no longer an exact WAL prefix, so a view pin (`db.ts:677-690`) would have to pin an IDB transaction. **Reject.** |
| H | Resolve `openDb` before replay and make reads await it | Better `open ms` number, same time to first read | Small | Cosmetic | Low. **Reject**: it only moves the wait. |
| I | Replay in the SharedWorker and ship a packed memtable image to each tab (`postMessage` of one `ArrayBuffer`, copied per tab) | Warm host: open ≈ copy + tail. Cold host: same cost as today, moved off the tab's main thread. | Large: the host must track every append in order and serve images at an exact seq | Adds a second in-memory LSM layer: KISS loses. Ingest to SST already gives the same thing durably (kv-sst open is 18–39 ms). | High: the image must be an exact WAL prefix at seq S, and the tab then reads the tail above S. Broadcast hints are lossy (`host/engine-host.ts:19-23`). **Reject** in favour of D, or ingest. |
| J | Snapshot the memtable (to IDB or OPFS) | Same as ingesting, without an SST | Medium | That is ingest under another name. **Reject**: use D. | Snapshot and WAL truncation must be atomic, which the IDB transaction in ingest already does. |
| K | Move replay or the memtable into wasm | At most −50 ms (the memtable span). IDB and structured clone (~85–90%) stay in the browser. | Large | The tab reads in TS on purpose, so `get` never crosses into wasm (`docs/design.md` "Where code runs") | **Reject**: wrong side of the cost. It may be worth revisiting after B+C, when decode of packed groups is the larger share. |
| L | Host-side WAL "segment compaction": rewrite runs of small WAL rows into packed rows in IDB, in one readwrite transaction | Like B+C for open, without changing the writer | Medium | A second ingest path. KISS prefers D or B. | Rewrite and delete happen in one transaction, so it is consistent. It does take IDB writer time from appends. |

Suggested order: A, then measure the default policy (D), then B+C as one format change, then E
if it still shows up.

## Notes and caveats

- The SQLite backend was not active in the measured profile (LevelDB directories on disk),
  even on Chrome 156. Per-row costs on SQLite may differ: Chromium says to expect shifts in
  CPU, memory and runtime. On SQLite, Blink skips Snappy compression and the 64 KiB blob
  wrapping (`idb_value_wrapping.cc`). On LevelDB, packed groups over 64 KiB are stored as blobs,
  and the 1000-per-row case (~123 KB rows) was still the fastest.
- `getAllRecords()` is Chrome/Edge 141+. MDN marks it "limited availability", so it needs a
  feature check and a fallback.
- The 4 MiB → ~100 ms estimate assumes this bench's row shape (~116 op bytes/row). Smaller rows
  mean more rows per MiB, and so slower opens at the same `maxWalBytes`. That is one more
  argument for B+C, which makes open cost track bytes rather than rows.
- Not measured: `getAllRecords` combined with packed rows, real group sizes under B, and
  anything in Firefox or Safari.

## Sources

Specs and Chromium:

- W3C Indexed Database API 3.0 (editor's draft), https://w3c.github.io/IndexedDB/.
  §2.3 Values: values are stored as the output of StructuredSerializeForStorage
  (`#value-construct`). §2.7.2 Transaction scheduling: read-only transactions may run
  concurrently, and overlapping read/write transactions are serialized
  (`#transaction-scheduling`). §2.11 Key generators: an abort reverts the generator
  (`#key-generator-construct`).
- Chromium `indexeddb.mojom`: `kIDBGetAllChunkSize = 1000` ("To avoid GetAll returning too
  much data in one mojo message, it is returned in chunks"), `kIDBWrapThreshold = 65536`,
  `kIDBMaxMessageSize` 128 MB,
  https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom
- Chromium `idb_value_wrapping.cc`: large values go to a Blob, with Snappy compression on
  LevelDB, and both are skipped when `backend_uses_sqlite_`,
  https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/indexeddb/idb_value_wrapping.cc
- Original value-wrapping change and its rationale (large values slow LevelDB compaction),
  https://codereview.chromium.org/2822453003/
- blink-dev PSA "IndexedDB: SQLite backend" (2026-04-24): ships in Chrome 150 for new
  stores, existing LevelDB data is not migrated yet, expect CPU, memory and runtime shifts,
  https://groups.google.com/a/chromium.org/g/blink-dev/c/jS0khnC5IWA
- "New in Chrome 141": `getAllRecords()` and the `direction` option for `getAll`/`getAllKeys`,
  https://developer.chrome.com/blog/new-in-chrome-141
- MDN `IDBObjectStore.getAllRecords()` (API semantics and the "limited availability" status
  only), https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAllRecords
- WHATWG HTML, structured serialization (`StructuredSerializeForStorage`, used by IDB) and
  `BroadcastChannel`/`postMessage`, which use StructuredSerialize(WithTransfer),
  https://html.spec.whatwg.org/multipage/structured-data.html and
  https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts
- WHATWG File System: `createSyncAccessHandle()` and `FileSystemSyncAccessHandle` are
  `[Exposed=DedicatedWorker]`, so not available in a SharedWorker or the main thread. This is
  why a synchronous OPFS WAL is not a drop-in option for this architecture,
  https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle

Repo:

- `packages/kv/src/db.ts:243-333` (open), `:388-421` (DbImpl, memtable per instance),
  `:485-562` (catchUp / sync), `:569-623` (append paths)
- `packages/kv/src/idb/wal.ts:44-67` (record codec), `:106-140` (getAll read), `:162-173`
  (tail), `:283-327` (counter, listUningested)
- `packages/kv/src/store/memtable.ts:26,106-140`
- `packages/kv/src/host/engine-host.ts:118-142` (watch reads only the counter),
  `packages/kv/src/host/ingest.ts:25-60`
- `packages/kv/src/ingest-policy.ts:16-18` (default 4 MiB)
- `examples/yjs/bench/main.ts:60,145-150,226-251`
- Commit `ea4b80c` (cursor → getAll, 60 → 43 ms on the automerge open bench), commit `156579d`
  (open no longer waits for watch)
- `docs/design.md` sections "WAL records", "Memtable", "Ingest", "Where code runs"

## Follow-up: recommendation 1 in place

Implemented in `packages/kv/src/idb/wal.ts` `readRecords`, then measured inside the real read
path on the yjs bench (`DOCS=5000`: 250,000 WAL rows; headless Chrome 156; same machine,
runs back to back).

A temporary probe in `readRecords` timed every variant on the same transaction and rows
(2 opens):

| Read | ms |
|---|---|
| `getAllKeys` + `getAll` (old) | 637 / 657 |
| `getAll` alone | 534 / 572 |
| `getAllKeys` alone | 86 / 98 |
| `getAllRecords` | 378 / 413 |
| decode of the `getAllRecords` result (reading `.value`) | **255 / 256** |
| `getAll` in 25k-seq ranges, all in flight | 425 / 515 |

`getAllRecords` returns quickly because Chrome has not deserialized the values yet **(inferred
from the timings: decode of `getAll` values is 18–75 ms, of `getAllRecords` values ~255 ms)**.
Its total cost equals the old path's. The scratch experiment in section 2 did not include
reading every `.value`, so it missed this.

The shipped version reads with `getAll` over 25,000-seq ranges, all in flight in one
transaction. Seqs are gapless above `ingestedThrough`, so a value's position gives its seq and
the `getAllKeys` pass goes away. A short range throws `wal gap`. The three readers (`tail`,
`listUningested`, `uningestedBytes`) read `head` first and fetch only `(ingestedThrough, head]`.

Bench, `DOCS=5000 RUNS=3`, medians, kv-wal:

| Read path | open cold / warm | all cold / warm | trace `wal-read` |
|---|---|---|---|
| `getAllKeys` + `getAll` (before) | 847 / 834 | 1030 / 996 | 666–698 (research run) |
| `getAllRecords` | 810 / 715 | 993 / 879 | 694–718 |
| ranged `getAll` (shipped) | **524 / 483** | **698 / 663** | **358–516** |

y-indexeddb in the same runs: 941–961 cold, 953–1074 warm. kv-sst did not change (it has
nothing in the WAL). Recommendation 2 (fewer, larger rows) is still the larger win left.

## Follow-up: byte rows and a 1 MiB ingest limit

Two more changes, measured on the same bench (`DOCS=5000 RUNS=3`, 250,000 updates, headless
Chrome 156).

**WAL rows as bytes.** `encodeOps` writes a batch as one `ArrayBuffer` (per op: type byte,
u32 key length, key, u32 value length, value). `decodeOps` hands out `subarray` views into it.
A row holds one batch, and nothing decoded from the WAL crosses `postMessage`, so the views
keep no extra memory alive. Rows in the old object format now throw `corrupt wal row: not
bytes`.

| kv-wal (auto ingest off) | open cold / warm | all cold / warm |
|---|---|---|
| ranged `getAll`, object rows | 524 / 483 | 698 / 663 |
| ranged `getAll`, byte rows | **351 / 353** | **527 / 599** |

That is a third off the open, more than section 2's ~20% for one `getAll` over the whole
tail.

**Default `maxWalBytes` 4 MiB → 1 MiB.** The bench's `kv` shape runs kv's default policy, and
`WAL_BYTES` overrides it. The WAL rows column is what the host had not ingested yet when the
write settled.

| `maxWalBytes` | WAL rows left | open cold / warm | all cold / warm | write 50k docs |
|---|---|---|---|---|
| 4 MiB | 29,912 | 71 / 91 | 243 / 266 | 48.1 s |
| **1 MiB** | 7,919 | **44 / 39** | **231 / 219** | 49.9 s |
| 256 KiB | 22 | 39 / 25 | 219 / 195 | 52.5 s |

1 MiB holds the open near 40 ms. 256 KiB saves little more open time for four times as many
ingests and L0 compactions. Write time grows a few percent per step, which is close to
run-to-run noise. Recommendation 2 (packing many records per row) was not pursued: with a
1 MiB WAL, the open is already about 20% of a 5,000-doc load.

