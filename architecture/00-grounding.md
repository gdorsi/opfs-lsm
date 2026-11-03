# Phase A grounding — async OPFS LSM KV (Dexie successor)

Greenfield product in `opfs-async/`. Surrounding systems: OPFS platform, Dexie/IndexedDB as replacement target, sync B+tree (`opfs-btree`) as contrast.

## Goal

Browser KV with an LSM on **OPFS async API** for sealed data, long-term **Dexie.js replacement**, substantially faster on the workloads that matter (bulk, scans, SST-backed reads). Near-term: bytes KV + clear path to a Dexie-shaped façade.

## Decided product forks (2026-11-03)

After architect synthesis and critique:

1. **Hybrid storage (fork B):** each tab’s **WAL lives in IndexedDB**; **SSTs and compaction live on OPFS**, coordinated by a SharedWorker.
2. **Shared autoIncrement IDB WAL:** one IndexedDB database per logical DB `name`; one `wal` store with `autoIncrement` keys (global seq). No per-tab `nextSeq` coordination. Optional `writerId` is metadata only.
3. **Ack = IDB commit:** `put`/`batch` resolves when the shared WAL transaction completes. **Other tabs see the write on their next `get`/`range`** by reading the uningested WAL (no OPFS wait).
4. **Ingest ≠ visibility:** SharedWorker ingest folds WAL → OPFS L0/SST and truncates; it is for durable SST layout / compaction / quota, not for cross-tab visibility.
5. **Reads are not on the SharedWorker hot path:** tab merges shared uningested WAL (seq order) over OPFS SSTs locally.

These supersede the earlier “ack ≠ cross-tab visible” fork.

## Platform constraints (must honor)

1. **Async OPFS** publishes a file version on writable `close`. Prefer immutable SST publication; avoid `keepExistingData` on large mutable files.
2. **Range reads** via `getFile` + `slice`.
3. **Multi-file atomicity** is not provided by the platform; generation/manifest protocol owns crash consistency of the SST set.
4. **IndexedDB** is used only as a **per-tab redo log** (small, append/sequential records), not as the primary store. Structured-clone cost on the WAL path is accepted for ack latency; the speed claim vs Dexie is for SST-backed and bulk work, not “every solitary put beats IDB.”
5. Vocabulary: dedicated WebWorker / SharedWorker / ServiceWorker; OPFS not “disk”; commit/durable/generation carefully — **ack ≠ globally visible generation**.

## Persistence model (v0)

| Stage | Guarantee |
|---|---|
| Resolved `batch` / `put` | Durable in the **shared** IDB WAL; visible to other tabs’ next IDB read. |
| After SharedWorker ingest | Same records in OPFS L0/SST + named in a generation; WAL rows truncated through that seq. |
| Tab crash before IDB commit | Write never acked; gone. |
| Tab crash after IDB ack, before ingest | Bytes remain in shared IDB; any tab / SharedWorker can ingest. |
| SharedWorker crash | In-flight ingest retries; already-acked IDB data remains until published and truncated. |

**Not claimed:** power-loss beyond IDB/OPFS browser guarantees; storage eviction; “Dexie-fast solitary put.”

## Contrast: sync B+tree

`opfs-btree` = Rust + sync access handle + single leader. Different API and coordination. Do not copy `SyncFile` as the async SST boundary.

## Non-goals for current sketch

- Immediate cross-tab visibility after ack
- Full Dexie API in v0
- Sync-access-handle engine
- Implementing code until sketch sign-off
