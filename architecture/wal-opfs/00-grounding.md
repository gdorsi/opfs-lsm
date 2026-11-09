# Grounding: moving the WAL from IndexedDB to OPFS

Date: 2026-11-08. Branch `bench/suite` at `052e0b8`.

## Goal

The IndexedDB WAL is the current bottleneck. Prototype a WAL on OPFS that needs
little coordination, in the spirit of SST compaction: work happens privately
(merge into a new run file with no lock), and only a short install step is
serialized (manifest publish + `raiseGeneration` under the ingest lock).

Project rules that bind the design (`AGENTS.md`):

- read/write performance above everything; KISS
- **consistency must be guaranteed, persistence need not be**
- no backward compatibility needed; the prototype may change the format and the API
- prefer an architectural change over a new cache

## How the system works today

| Piece | File | Role |
|---|---|---|
| `IdBWal` | `packages/kv/src/idb/wal.ts` | IDB db `opfs-lsm-wal/<name>`. Store `wal`: seq → one packed `ArrayBuffer` per batch. Store `meta`: `head`, `ingestedThrough`, `generation`, `pendingBytes`. |
| `DbImpl` | `packages/kv/src/db.ts` | Per tab. Memtable over the installed SST generation. Reads never touch IDB. |
| `EngineHost` | `packages/kv/src/host/engine-host.ts` | In the SharedWorker. Watches WAL bytes, folds the WAL into L0 (`ingest.ts`), compacts (`compact.ts`). |
| generations | `packages/kv/src/store/generation.ts` | Immutable manifests `m/<gen>.mft` listing runs. Runs are immutable files. |

Write path. `batch` → `IdBWal.append`: one readwrite tx, `add` with the key
generator assigning the seq, `put head`, `put pendingBytes`. If the generated
key is stale (an `appendAfter` wrote an explicit key), abort and retry with
`appendAfter`. Seqs are global and gapless. Ack = tx `complete` (relaxed
durability: survives a tab crash, maybe not power loss). Then `landed`: apply
to own memtable (if a gap, `sync()` first), broadcast `{append, seq, ops}`.

`update(keys, body)` → `appendAfter`: in one readwrite tx, read the tail above
`appliedThrough`, apply it to the memtable, run `body` synchronously against
memtable+SST, add at `head+1`. This is the only read-modify-write primitive and
`@opfs-lsm/collections` builds on it (index maintenance), so it must stay
serializable.

Visibility. Other tabs get `{append, seq, ops}` over BroadcastChannel and apply
it if it is the next seq; otherwise `sync()` re-reads the tail. `sync()` reads
the IDB tail in one tx. Invariant: **the memtable is always one exact prefix of
the global log**, and the installed generation never covers seqs past it. A
`view` pins (`appliedThrough`, generation, memtable chunks, levels).

Ingest (host, under Web Lock `opfs-lsm-ingest/<name>`): list uningested records,
fold to last-op-per-key, write `l0/<first>-<last>.sst`, publish manifest
`gen+1`, then one IDB tx deletes records `<= last` and sets `ingestedThrough`
and `generation`. Tabs switch generation by reading `generation` +
`ingestedThrough` from the same IDB tx as the tail, so "the generation" and
"the WAL cut" are always read atomically. That atomic pair is the thing an OPFS
WAL must replace.

Compaction (the model the user wants to copy): `mergeNextStep` reads the latest
manifest and merges with **no lock**; `installStep` re-checks inputs are still
live and publishes the new manifest under the ingest lock. Concurrent flushes
only prepend L0 runs, so the merge stays valid.

Crash table (design.md): every intermediate state is safe because IDB's
`generation` is the commit point and orphan files are garbage.

## Where the WAL costs today (bench, Chrome 156, M5 Max)

- `kv/fillsync` single awaited puts: kv **244 µs p50** vs raw IDB 114 µs.
- `yjs/trace` persist (one put per keystroke): kv 821 ops/s vs y-indexeddb 1815.
- `update` (ycsb): kv 220 µs p50 vs raw IDB 114 µs.
- Open replays the whole uningested WAL per tab; cost is per IDB row
  (~1.6–2.7 µs/row), bounded by `maxWalBytes` = 1 MiB.
- Bulk `batch` of 1000 is already fine (2 ms).

## OPFS primitive measurements (this session)

Probe: `scratchpad/opfs-probe`, headless Chrome 156, cross-origin isolated,
120-byte records, 500 iterations.

| Primitive | Cost |
|---|---|
| IDB append shaped like today's WAL (add + 2 meta puts) | ~195 µs avg, 200 p50 |
| IDB single put | ~120 µs |
| OPFS async API, new file per record (main thread) | 700 µs p50, 1.8 ms p99 |
| OPFS async append, `createWritable({keepExistingData})` | 800 µs p50; **2 ms at 1 MiB** (copies the file) |
| SyncAccessHandle write in a dedicated WebWorker, no flush, **incl. postMessage round trip from main** | **~21 µs** |
| same, in-worker only | ~3 µs |
| SAH write + `flush()` | ~500 µs (an fsync) |
| Web Lock acquire, uncontended | 50 µs p50, 113 avg, 725 p99 |
| Web Lock + SAH append round trip | 65 µs p50, 73 avg |
| BroadcastChannel one way | 70 µs p50 |
| Spawn dedicated WebWorker + open SAH | ~10 ms |
| `getFile().arrayBuffer()` of 1 MiB | 0.65 ms |

Behavioural facts:

- `createSyncAccessHandle` exists **only in dedicated WebWorkers**. The SharedWorker has none.
- Default mode is exclusive: a second SAH, or a writable, on the same file throws `NoModificationAllowedError`.
- `mode: "readwrite-unsafe"` lets several dedicated WebWorkers hold handles on one file at once and see each other's writes. `"read-only"` cannot coexist with `"readwrite-unsafe"`.
- The main thread and the SharedWorker **can** `getFile()` and read a file while another context holds an exclusive SAH on it, and they see unflushed writes.
- A `File` from `getFile()` throws `NotReadableError` if the file changes before it is read. Readers must retry, and must tolerate a torn last record (framing with length + checksum).
- SAH writes without `flush()` reach the OS (they survive a tab crash, not necessarily power loss). That is the same durability as today's relaxed IDB commit, and AGENTS.md allows it.

- (Follow-up probe.) The SharedWorker's `getFile()` read works while other workers hold `readwrite-unsafe` handles, and while one holds an exclusive handle.
- (Follow-up probe.) `removeEntry` throws `NoModificationAllowedError` while **any** SAH (exclusive or `readwrite-unsafe`) is open on the file, and succeeds once it is closed. A writer that stays open is not affected by a failed remove.

Conclusions the design must respect:

1. The OPFS hot path must be a SyncAccessHandle in a dedicated WebWorker. The async API is 4–10× slower than IDB.
2. Never `flush()` per write. Durability = written to the SAH.
3. Per-write cross-context coordination has a price: one Web Lock ≈ 50–110 µs, a BroadcastChannel hop ≈ 70 µs. A design that pays one lock per write still beats IDB (~195 µs) but by less than one that pays none.
4. The SharedWorker can read logs but not write them with an SAH.

## Invariants to keep or deliberately replace

- I1. Ack ⇒ the writer reads its own write; every tab that calls `sync()` after the ack sees it.
- I2. Every read sees one consistent state (today: one global-log prefix).
- I3. `update` is serializable against all other writes.
- I4. Ingest never loses or duplicates a write, and a crash at any step leaves a readable database.
- I5. Reads never cross a thread boundary (the tab reads its own memtable + SST readers).
- I6. Open time stays bounded by the ingest policy.
