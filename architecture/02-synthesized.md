# Synthesized design — hybrid IDB WAL + OPFS SST

**Status:** revised after agree-phase critique (2026-11-03).  
**Fork:** B — shared autoIncrement IndexedDB WAL, SharedWorker OPFS SST/compaction.  
**Ack:** IDB commit (cross-tab visible via shared WAL; ingest moves to OPFS).

Earlier arena candidates (TS single-writer SharedWorker-everything; Rust multi-writer OPFS-only) remain in `architecture/candidates/` as history. This document is the contract.

## Problem

Build a browser KV that can replace Dexie: durable local writes with low ack latency, and a fast immutable SST layer on async OPFS for sealed data, scans, and compaction. Routing every read through a SharedWorker loses to Dexie on point gets. Making OPFS the only durability medium forces either expensive L0 publishes per commit or a multi-writer OPFS protocol. IndexedDB is a poor primary store but a workable **shared autoIncrement redo log** (global seq, no tab sequencers); OPFS is a good **immutable run** store.

## Usage (caller's view)

```ts
import { openDb, prefixBound } from "@opfs-lsm/kv";

const db = await openDb({ name: "notes" });

// Resolves when the shared IDB WAL has committed — other tabs can get() it next.
await db.put(key, value);
await db.batch((tx) => {
  for (const row of rows) tx.put(row.key, row.value);
});

// Memtable first, then SST readers for the installed generation. No SharedWorker hop for the get.
const v = await db.get(key);

await db.view(async (snap) => {
  // Snapshot: pinned generation + WAL through a seq (policy TBD).
  for await (const e of snap.range(prefixBound(prefix))) { /* … */ }
});

await db.close();
```

Later `@opfs-lsm/collections` encodes tables/indexes as byte keys on this API.

Docs: **ack ⇒ durable in shared IDB and visible to other tabs via WAL reads; ingest is OPFS publish/truncate.**

## Shape

### Language

| Layer | Language | Owns |
|---|---|---|
| `engine-core` | Rust → WASM | memtable ops, WAL record codec, SST build/read, compaction merge, manifest/generation codec, ingest merge (WAL batch → L0 keys) |
| `@opfs-lsm/kv` | TypeScript | public API; shared IDB WAL and memtable adapter; OPFS SST adapter; tab reader; SharedWorker host for ingest, compact, and reclaim |

Rust does not call IDB or OPFS. Shell feeds bytes / intents; same discipline as before.

### Concurrency and ownership

```
Tab (main or dedicated WebWorker)
  ├── IdBWal          append to shared autoIncrement wal store
  ├── SstReader       OPFS range reads for pinned generation (local)
  └── IngestClient    asks SharedWorker to fold WAL → OPFS

SharedWorker
  ├── IngestEngine    listUningested → L0 + generation → advanceIngested
  ├── Compactor       merges SSTs, publishes new generation
  └── Reclaim         deletes unreferenced SST/generation after pin locks clear
```

| State | Owner |
|---|---|
| Shared IDB WAL (append) | Any tab (IDB serializes) |
| `ingestedThrough` + truncate | SharedWorker ingest |
| Published generation + SST set | SharedWorker |
| Tab read view | That tab (shared WAL ∪ SSTs) |

**Single OPFS publisher:** SharedWorker is the only agent that `createWritable`s SST/generation files. Tabs write IDB and read OPFS (+ shared WAL).

### Ack and visibility

1. `batch` appends to the shared autoIncrement WAL and updates the memtable in that IndexedDB transaction. The ack resolves when the transaction commits.
2. Another tab's `get` reads the memtable first. On a miss, `get` reads SST files for the generation that `currentReaders` installed.
3. Background or explicit ingest runs in the SharedWorker. It folds the uningested WAL into an L0 SST, publishes a generation, sets `ingestedThrough`, and deletes those WAL rows and memtable rows.
4. After ingest, each tab clears `openGeneration` before the next SST read. `currentReaders` calls `loadLatestGeneration` and opens the new SST readers.

The SharedWorker posts a `generation` message on each connected port. `createPortIngestClient` clears `openGeneration` when that message arrives. A BroadcastChannel `ingest` from another writer clears it too. `currentReaders` reuses SST readers only when `openGeneration` already has the manifest's generation number. A newer manifest replaces them.

### Persistence guaranteed

- **After ack.** The write is durable and visible to other tabs from the shared IndexedDB WAL and memtable.
- **After ingest.** The write is also in the OPFS generation and its SST files. The ingested WAL rows and memtable rows are gone.
- **Not after ack alone.** The write is not on OPFS until ingest.

### Storage layout

**IndexedDB** (per origin, **one IDB database per logical `openDb` name**):

```
wal store: autoIncrement seq to { optional writerId, ops: put or delete }
mem store: user key to the latest put or delete, in the same transaction as the WAL ack
meta store: ingestedThrough to a number
```

**Decided:** one shared autoIncrement WAL. IDB assigns global seq; no per-tab `nextSeq`. `writerId` is optional metadata. Ingest advances a single `ingestedThrough` and deletes `seq ∈ (old, through]`.

**OPFS** (`opfs-lsm/<name>/`):

```
m/<generation>.mft
l0/<writerId>_<seqRange>.sst
sst/<compactionId>.sst
```

Immutable publish only; no `keepExistingData`.

### Reads (where they happen)

Reads run in the tab, on the page thread or in its dedicated WebWorker.

1. The key-ordered IndexedDB memtable holds the newest write for each key.
2. SST readers for the installed generation come from OPFS `getFile` and `slice`. `currentReaders` stores them on `openGeneration`.

`loadLatestGeneration` lists `m/*.mft` from newest to oldest. It skips an empty file or a manifest that fails to decode. It returns the newest manifest that decodes.

The SharedWorker is not on the `get` path.

### Public surface

`openDb`, `prefixBound`, `Db.{get,put,delete,batch,range,view,close,changes}`, errors.  
Internals (`IdBWal`, intents, worker protocol) not exported.

### Interface depth

Callers see: “promise resolved ⇒ durable in shared IDB and readable by other tabs.”  
Ingest/compaction stay hidden. Collections may assume cross-tab read-your-writes after `put` **via IDB**, not via OPFS.

## Tradeoffs accepted

- We accept **IndexedDB on the ack path** for durable + visible ack without an OPFS `close` per put.  
- We accept **one WAL store / IDB tx queue** across tabs in exchange for a global seq and no writer sequencers.  
- We accept “faster than Dexie” mainly for **SST-backed / bulk / scan**; solitary put may be ≈ IDB.  
- We accept Rust WASM for SST/compaction CPU; WAL encode may stay TS initially.

## Alternatives considered

- **SharedWorker for all reads/writes:** port latency vs Dexie. Rejected.  
- **Ack = SharedWorker ingest:** SW on write critical path. Rejected.  
- **Per-writer `[writerId, seq]` WAL:** needed explicit sequencers; delayed cross-tab visibility unless readers merged all partitions. Replaced by autoIncrement shared WAL.  
- **OPFS-only WAL segments:** fallback if IDB WAL is too slow/quota-bound.  
- **Multi-writer OPFS L0:** hard protocol. Rejected for v0.

## Open questions and risks

1. **Ingest trigger:** size / count / max delay — bound for WAL→OPFS lag (quota), not for visibility.  
2. ~~WAL keying~~ — **decided: shared autoIncrement + single `ingestedThrough`.**  
3. **Same-tab `view` isolation:** WAL ≤ open seq vs always latest.  
4. **IDB quota vs OPFS quota** when ingest lags.  
5. Package name still open.

## Next implementation step

~~IDB WAL + memory FS + ingest stub~~ done.  
~~SharedWorker/`EngineHost` + MessagePort protocol~~ done (`host/engine-host.ts`, `host/shared-worker.ts`).  
~~Browser OPFS `AsyncFs`~~ done (`opfs/browser-fs.ts`).

~~Binary SST + generation~~ done (`store/sst.ts`, CRC footers).  
~~Browser `openDb` + SharedWorker export~~ done (`workerUrl` + `@opfs-lsm/kv/shared-worker`).  
~~Ingest triggers~~ done (`ingestPolicy`: maxBatches / maxBytes / maxDelayMs).

~~Rust `engine-core` + WASM SST/merge~~ (`crates/engine-core`, `crates/engine-wasm`).  
~~L0 compaction + reclaim~~ (`host/compact.ts`, threshold 4).

~~Interactive transactions (key OCC)~~ (`transaction()`, `ConflictError`).  
~~Browser OPFS bench~~ (`pnpm bench:browser` — Chrome headless, SharedWorker + OPFS; Node fake-idb speed bench removed).  
~~`db.view` snapshot~~; ~~`@opfs-lsm/collections`~~ (typed/compound indexes).  
~~`changes()`~~; ~~collections `orderBy` / index range~~.  
~~Bloom filter primitive~~ (TS + Rust).  
~~SST v2~~ multi-block + Bloom + block index; ~~`SstReader` / `SstLayer`~~ lazy point gets on the hot path. v1 decode kept.

Next: collections live queries on `changes()`; SST block cache tuning / prefix compression.
