# Async LSM on Rust → WASM

## Problem

We need a browser key-value database on the OPFS async API that can grow into a Dexie.js replacement and beat IndexedDB on batched work. The sync B+tree already shows that a Rust engine can ship as WASM, but its storage boundary is `SyncFile`: positional `read_exact_at` / `write_all_at` / `truncate` / `flush` on one exclusive file inside a dedicated WebWorker. That boundary fights this engine. Async OPFS publishes a whole file version on `close`, can copy an existing file when an update uses `keepExistingData`, and lets every agent write a distinct file. A long-term façade needs tables, indexes, and atomic multi-key updates; this pass only freezes the language split, the public surface, and which agent owns each piece of state. Ordering, acknowledgement, and reclaim stay explicit proposals with a single owner each, not an invented protocol hiding in comments.

## Usage (caller's view)

Apps depend on one package. They never import the WASM glue, the OPFS adapter, or the worker scripts.

```ts
import { openKv, type BatchOp, type View } from "@opfs-lsm/kv";

const db = await openKv("notes");

await db.batch([
  { type: "put", key: utf8("a"), value: utf8("1") },
  { type: "delete", key: utf8("b") },
]);

const value = await db.view((v) => v.get(utf8("a"))); // Uint8Array | null

await db.view(async (v) => {
  for await (const row of v.range({ start: utf8("a"), end: utf8("z") })) {
    // row.key / row.value, generation frozen for this callback
  }
});

for await (const generation of db.changes()) {
  // later live queries rerun a view; this iterator does not pin a snapshot
}
```

`put` and `delete` exist only as wrappers that send a one-operation `batch`. The dedicated WebWorker has one `Batch` handler. Reads during a `view` send the generation captured when the callback started, so a newer commit cannot change the snapshot under it.

Call site — a notes screen, after the user leaves a field:

```ts
await notes.put(utf8(`note:${id}`), utf8(body));
// resolves only after the write is committed (see Shape)
const saved = await notes.view((v) => v.get(utf8(`note:${id}`)));
```

Call site — a bulk import. One batch is one commit, not one publication per key:

```ts
const ops: BatchOp[] = rows.map((row) => ({
  type: "put" as const,
  key: utf8(row.id),
  value: row.bytes,
}));
await db.batch(ops);
```

Call site — the later collections façade, the only intended second caller. It does not open OPFS and does not know about manifests. A table write is one conditional batch so the primary record and its index entries commit together, and so a stale read-modify-write fails instead of landing on top of another tab:

```ts
await kv.batch(
  [
    { type: "put", key: primaryKey(store, obj), value: encode(obj) },
    { type: "put", key: indexKey(store, "byTitle", obj.title, obj.id), value: EMPTY },
  ],
  { ifGeneration: view.generation() },
);
```

Keys are raw bytes compared unsigned-lexicographic. `range` is `[start, end)`. A missing key is `null`, not an error. `openKv` takes a database name and no engine tunables.

## Shape

**Language.** Rust owns the LSM: memtable, record framing and checksums, SST build and read, compaction merge, manifest codec, overlay order, and the decision of which runs to merge. That code is `engine-core`, compiled to `wasm32` and exported by a thin `engine-wasm` crate. TypeScript owns the async OPFS adapter, the dedicated WebWorker that drives one tab's writer, and the SharedWorker that hosts the manifest owner and the compactor. The Dexie-shaped API is a later package on top of `Kv`, not a second engine. per boundary-discipline, DOM types die in the adapter; per encode-lessons-in-structure, a writer engine has no method that publishes a manifest.

**Storage boundary, in contrast to `SyncFile`.** There is no file trait in Rust. No `write_all_at`, no `truncate`, no `flush`, no async twin of `SyncFile`. The engine is a pure function of its in-memory state plus byte buffers the shell feeds back. It returns intents (`publish` this object, `read` these ranges, `delete` these names, `list` this prefix). The shell is the only code that touches `FileSystemFileHandle`, writable streams, or Web Locks. Tests drive the same intents with in-memory completions. Adding a positional file trait would reopen the sync engine's layout; that change means the design has been abandoned.

**Data, then flow.** A batch builds a memtable (`BTreeMap` from user key to put or delete), then seals it. The sealed bytes are one immutable L0 run: a single-block SST with the same record framing, checksum, and reader as a compacted SST. There is not a second on-disk log. Classic write-ahead into a growing file would be a large mutable object, which is the OPFS cost we are avoiding, and a second reader that other tabs would have to learn. The L0 run is the write-ahead step: it is durable once `close` returns, and it stays invisible until a manifest generation names it. Compacted runs are multi-block SSTs (index, Bloom filter, footer) produced later. Overlay order is the run list in the manifest, newest L0 first, then non-overlapping higher levels. The first hit wins; a tombstone returns `null`. No per-key sequence number that could disagree with that list. per separate-before-serializing-shared-state, each tab's memtable is private and lives only for the batch being sealed; other tabs never merge RAM. They merge published runs at read time.

A generation file `m/{generation}` is an immutable publication. The highest checksum-valid generation is the current one. There is no `CURRENT` pointer beside it. Manifest files stay small because compaction bounds the run list; every commit rewrites a small file and never patches a large one with `keepExistingData`.

**Who owns what.**

| State | Owner |
| --- | --- |
| Memtable, L0 bytes for this batch | That tab's `WriterEngine`, inside its dedicated WebWorker |
| Manifest generations, writer epochs, compaction policy | `ManifestEngine`, only inside the SharedWorker |
| Compacted SST bytes | `CompactorEngine`, only inside the SharedWorker, from a job the manifest owner handed it |
| OPFS handles and range coalescing | `OpfsAdapter` |
| Snapshot pin and reclaim lock | Broker code in the SharedWorker, using the generation `ManifestEngine` names |
| Byte-prefix schema for tables and indexes | Later collections package |

Tabs do not RPC their values through a leader. Each writer publishes its own L0 object under a name derived from `(writerId, epoch, batchSeq)`. The SharedWorker only orders those names. That is the independent-writer stance: many writers of distinct immutable files, one owner of the generation. A frozen tab freezes its own worker and its in-flight `close`; it does not freeze the manifest owner. The compactor is not a writer of user keys. It submits a compaction proposal; `ManifestEngine` is still the only type that emits the next generation's bytes.

**Commit and acknowledgement.** Durable means the L0 object's `close` returned. Committed means the generation file that names it has `close`d. `batch()` resolves when the manifest owner has applied that proposal and sent the ack. Another tab's next `view` asks the owner for the current generation, so it sees the write. A `view` already in progress keeps the generation it pinned. Crash before the generation `close`: not committed; the writer republishes and resubmits. Crash after `close` but before the ack reaches the page: committed; resubmit is a no-op because the proposal id is already in the generation. Orphan files (durable, unnamed) are invisible and are deleted only when `ManifestEngine` reports them unreferenced and the broker wins the exclusive reclaim lock. per make-operations-idempotent, proposal ids and compaction job ids are applied once; rewriting the same generation bytes is success; rewriting them with different bytes is corruption.

**Reads.** `view` captures one generation, takes the shared Web Lock named for that generation, and drops it when the callback settles. Point reads and ranges share one planner. The planner asks for index and data ranges; the adapter coalesces adjacent OPFS `slice` calls and returns exactly the requested ranges. Block caches live inside the WASM engine that parsed the blocks, keyed by immutable object name, dropped when that run leaves the local manifest view.

**Concurrency stance.** Multi-writer, single manifest owner, single-flight queue inside each tab worker. Same-tab `batch` then `view` run in order on that queue, so read-your-writes does not need a second copy of the memtable after the ack. Cross-tab conflicts are last-generation-wins per key. A batch may carry `ifGeneration`; the owner checks the applied-set first (retry of a commit that landed still succeeds) and then rejects a new proposal whose expected generation is stale. That conditional batch is the isolation hook the façade will use for read-modify-write. It is the same apply path, not a second write API.

**Interface depth.** The public surface is `openKv`, `batch`, `view`, `changes`, and `close`. Behind it: record codecs, checksums, Bloom filters, compaction, epochs, OPFS publication, worker placement, range coalescing, and reclaim. Callers do not learn those to store a byte array. The shell is not a pass-through. `Kv` turns sugar into one `Batch` or `View` message. The driver turns intents into publications and defines when the promise resolves. The broker turns a proposal into a generation and a Web Lock. Each hop adds a policy the callee owns. Worker placement is an agent boundary, not an extra abstraction layer: there is no separate client class with the same signatures as `Kv`.

**What the design refuses.** ServiceWorkers. The sync API and sync access handles. A `CURRENT` file. A growing mutable WAL. Engine tunables on `openKv`. Hosting the manifest owner in a tab's dedicated WebWorker in v0 (a freeze would hold the Web Lock and stall every writer). Silent group commit across separate `await`s (that would make acknowledgement late). Two SST readers.

Internals stay unreachable from apps: `@opfs-lsm/kv` exports only the public entry, `engine-wasm` is a private workspace package, and codecs are `pub(crate)`. The intent enum and the error enum are generated from the Rust types so TypeScript cannot keep a second list. per laziness-protocol, a put is explained by the public `Kv`, the tab driver, and `WriterEngine`; the broker is a sibling behind `submit`, not another wrapper in the same stack.

## Synthesis decision

(single candidate; orchestrator fills)

## Tradeoffs accepted

- We accept a WASM copy and a SharedWorker round trip on every acknowledged batch in exchange for keeping OPFS and tab coordination out of the engine and off the main thread.
- We accept one small manifest publication per batch in exchange for "awaited `batch` is committed and visible to the next `view` in another tab." Speed comes from putting many keys in one batch, not from delaying the ack.
- We accept last-generation-wins, with an optional generation fence, in exchange for a total order the manifest owner can enforce without merging values.
- We accept no separate redo log in exchange for one publication per batch and one run reader. The L0 SST is the write-ahead record.
- We accept writes failing when the SharedWorker is gone in exchange for not pinning the manifest owner to a dedicated WebWorker that a freeze will not unlock.
- We accept writer backpressure when the L0 count hits an internal ceiling in exchange for a dead compactor not turning every read into a scan of unbounded overlapping runs.
- We accept that "faster than Dexie" is unproven in exchange for a shape a bench can sit on: same `batch` / `view` workload against IndexedDB, with publication count visible in the adapter.

## Alternatives considered

- **Async `SyncFile` (`read_at` / `append` / `flush`) implemented with `web-sys` inside Rust.** Same surface area as the sync engine, so callers of the trait still think in mutable offsets. It hides almost nothing about OPFS (page size, `keepExistingData`, exclusive handles leak into engine policy) and it makes every test a browser test. Rejected.
- **One WASM module on the main thread, no dedicated WebWorker and no SharedWorker.** Shorter call chain and a smaller shell. It hides less of the real constraint: compaction and a manifest `close` would jank the page, and a frozen page would freeze the only owner. Rejected.
- **Sync-handle LSM.** One exclusive file, one leader, `SyncFile` unchanged. Deep engine, but the public story collapses to the sync B+tree's coordination, the compactor cannot run in the SharedWorker (no sync API there), and in-place WAL growth is the expensive OPFS path. Rejected inside this direction.
- **Leader tab owns the only `WriterEngine`; other tabs RPC puts.** The app-facing `Kv` could stay identical, so interface depth looks the same, but the hidden policy is single-writer. A freeze of the leader stalls every tab, and independent file publication — the reason to use the async API — goes unused. Rejected.
- **A JS-implemented `ObjectStore` trait awaited from Rust.** The engine looks deeper and the shell looks thinner, but the shell still has to coalesce ranges, hold pins, and decide acknowledgement. Those policies would either leak into the trait or live in a second interpreter beside it. The intent loop keeps that policy in one driver and leaves `engine-core` free of `Send` and JS promises. Rejected.
- **One `Engine` type with a role flag.** Easier bindings, and a writer worker could call manifest publish because the method would be sitting there. Separate `WriterEngine`, `ManifestEngine`, and `CompactorEngine` types make the illegal call a compile error. Rejected the unified type.

## Open questions and risks

- Is last-generation-wins, plus `ifGeneration` on `batch`, enough isolation for a Dexie-shaped transaction, or do cross-tab read-modify-writes need a per-key compare-and-swap before the façade is credible?
- The ack point above is "generation file `close`d and the owner sent the ack." Should a committed generation that no other tab has fetched yet still count as visible, with `view` defined to fetch first?
- What L0 ceiling should stall writers? Too low and compaction latency blocks puts; too high and overlapping runs dominate reads.
- When the SharedWorker dies mid-`close`, is a checksum-invalid generation file always treated as absent (this sketch says yes)?
- Safari and other browsers can still kill a SharedWorker. Is "writes fail closed until it comes back" acceptable for v0, or do we owe a heartbeat and steal so a visible tab can host `ManifestEngine` without getting stuck under a freeze?
- How large may a single value be before it stops being an inline record and becomes its own immutable object? The byte KV can defer that, but the façade will hit it.

Biggest risk: single-key latency. Each ack pays a structured clone into the dedicated WebWorker, a WASM copy, one L0 `close`, one small manifest `close`, and a broker hop. That can lose to IndexedDB on tiny puts even if a thousand-key `batch` wins. The shape makes the bench the next proof, not an assumption.

## Next implementation step

Write `engine-core` `WriterEngine::seal` and `ManifestEngine::apply` with in-memory intent completions: commit a batch, crash before the ack, recover from the generation bytes, and read the key back, with no WASM and no OPFS.
