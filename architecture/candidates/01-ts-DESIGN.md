# TypeScript LSM on async OPFS

## Problem

We want a browser key-value database whose storage engine is an LSM on the async OPFS API, fast enough to be a long-term Dexie.js replacement, with a near-term surface of `get` / `put` / `delete` / `range`. Async OPFS publishes one file when a writable stream `close`s, and staging an existing file with `keepExistingData` can copy the whole file, so the hot path has to be immutable files and range reads. A write is acknowledged only when a fresh opener can recover it and any other tab can read it; a memtable-only success does not count, and durable SST bytes that no manifest names are still invisible. Dexie-shaped call sites and SharedWorker coordination are the target shape. The engine is TypeScript. Multi-file crash order, fencing a zombie `close`, and compaction versus commits have to have owners in this sketch even where the policy constants stay provisional.

## Usage (caller's view)

The package entry is the whole public surface. A caller opens a named database, passes `Uint8Array` keys and values, and treats a resolved promise as a committed write. `put` and `delete` are a batch of one operation. `batch` is how bulk work shares a single commit. The callback is synchronous: the engine takes the write set when the callback returns. A `range` yields each key at most once, as of iterator start. `get` returns the latest acknowledged value at the time it resolves. `prefixBound` is byte-key arithmetic for "starts with", using the same unsigned bytewise order as the engine.

```ts
import { openDb, prefixBound } from "opfs-lsm";

const db = await openDb({ name: "notes" });

const enc = new TextEncoder();
const sessionKey = enc.encode("session");
await db.put(sessionKey, enc.encode("abc"));
const session = await db.get(sessionKey); // Uint8Array | undefined
await db.delete(sessionKey);
```

Bulk import, one commit for the whole write set:

```ts
await db.batch((tx) => {
  for (const row of rows) tx.put(row.key, row.value);
});
```

A list view over a key prefix:

```ts
const notes = prefixBound(enc.encode("note/"));
for await (const entry of db.range({ ...notes, limit: 50 })) {
  render(entry.key, entry.value);
}
await db.close();
```

`close` detaches this tab. It does not delete bytes. Programming mistakes (detached buffers, a thenable `batch` callback, a name that is not a single path segment) throw `ConstraintError` before any commit. A failed publication rejects with `CommitError` and leaves the previous acknowledged state in place. `CorruptDatabaseError` means recovery refused the files. `ClosedError` is use after `close`.

Later, a separate tables package — not part of this sketch's types — sits on that same `Db` and encodes a Dexie-shaped call into one batch and a prefix range:

```ts
const app = await openDatabase({
  name: "crm",
  schema: { friends: "id, name, age" },
});
await app.friends.put({ id: "f1", name: "Ada", age: 36 });
const ada = await app.friends.get("f1");
```

## Shape

One SharedWorker per origin hosts every named database. The tab runs a façade. The façade validates, copies bytes, and posts a commit, get, or range to the SharedWorker. The engine inside that SharedWorker is the only writer and the only reader of OPFS for this database. Tabs never call `getDirectory`, and they never see a memtable, a WAL file, an SST, or a manifest. ServiceWorker is unused. The sync API and sync access handles are unused.

The in-memory ordered map is a B-tree (fanout 32) whose keys and values live in a byte slab. Insert is logarithmic. An existing key is overwritten in place and a delete sets a tombstone flag; the tree does not rebalance removals. Each memtable holds one version per key. `MemHit` is `miss` | `tomb` | `value`, so a tombstone is not a missing key. Unsigned bytewise order lives in one function. There is no caller-supplied comparator.

User commits are group-committed. The engine pump takes every batch already queued, writes one new WAL file (create, write, `finish` / async OPFS `close`, no `keepExistingData`, no append API), and only then applies that file to the memtable synchronously and resolves the promises. A solitary `put` is a group of one. Concurrent batches already posted by any tab share one file. The promise resolves after `finish` and after apply, so acknowledgement means a fresh opener can replay the file and other tabs' `get`s can see the value. The manifest is not on this path. Sequence numbers are a single global counter derived at recovery from `sealedThrough` and the replayed WAL files, then advanced only as files finish. A failed `finish` that still left a valid file counts as success (the publication is idempotent). Sequence numbers already handed out are never reused.

Seal swaps the active memtable for an empty one when the slab's live bytes cross an internal threshold (provisional: 8 MiB). At most one memtable is sealing. Commits keep landing in the new active memtable until a hard cap (provisional: 16 MiB). Further groups stay queued while the same pump writes the next SST block, then they proceed. A queued group never waits on a seal the pump has stopped running. The pump writes the sealed map as a new SST in blocks, yielding a macrotask between blocks so queued commits run. It then publishes a manifest generation and only afterwards deletes WAL files with `seq <= sealedThrough`. An SST `finish` with no manifest publish is durable and invisible. Recovery replays WAL files and ignores SST files the manifest does not name. It does not adopt orphans. That is the one recovery path.

Compaction is the same pump, hosted in the SharedWorker, behind the same writer lock: plan a job from the manifest, merge immutable inputs, `finish` one new SST, publish the generation, then reclaim. L0 may overlap and is stored newest-first. Later levels are sorted and non-overlapping; `manifest.ts` checks that on load and before publish, and the engine trusts the in-memory manifest after that (per boundary-discipline). Provisional policy: compact when L0 holds four SSTs, fanout 10. Those constants live next to the planner and nowhere else. Reclaim deletes files no pinned generation names, and only when this agent's pin count for that generation is zero and an exclusive `ifAvailable` Web Lock on `opfs-lsm/${name}/gen/${generation}` is granted. The pin count is the same-agent signal, so reclaim does not deadlock on a shared lock this agent still holds. The exclusive writer lock `opfs-lsm/${name}/writer` is held for the life of the engine; it is the only lock that gates publication.

A new engine incarnation, still under that lock, reads the manifest epoch, lists `wal/` once, replays this epoch's files above `sealedThrough` into a memtable, copy-forwards that memtable into one WAL file named with `epoch + 1` when there is anything to forward, and publishes a manifest whose epoch is the new one. Only then does it accept commits. A zombie `close` can only land a file of the old epoch. Replay on every future start reads the epoch the manifest names. Old WAL files are deleted only after that manifest `finish`. Acknowledged bytes are in the listing, so they are copy-forwarded. Unacknowledged bytes that appear after the listing stay invisible. Per make-operations-idempotent, replay skips `seq <= sealedThrough`, and a retried batch carries an idempotency key stored in the WAL header and, once sealed, in a capped manifest list, so a lost `ok` does not apply the batch twice while the key is remembered.

`get` checks the active memtable, then the sealing memtable, then SSTs newest-first, one block via the SST index (`getFile` + `slice`). After every await it rechecks the memtables, which are always newer than SSTs. `range` copies the memtable in order at iterator start and merges it with a pinned SST generation, so a scan does not tear and does not observe later commits. `collapse` (newest version per key, tombstone hides the key) is the one visibility function used when building an SST. Point reads use the layer order instead of a second policy.

Public surface: `openDb`, `prefixBound`, and `Db` with `get`, `put`, `delete`, `batch`, `range`, `close`, plus `ConstraintError`, `CommitError`, `ClosedError`, `CorruptDatabaseError`. Package exports are only `"."`. Wire messages, `AsyncFs`, the manifest, and engine types are not exported. `put` and `delete` call `batch`. The wire has a commit message and no separate put message (per encode-lessons-in-structure). `AsyncFs` exposes `create` / `write` / `finish` / `abort` and range `read`. It has no append. `browser-fs.ts` is the only module that calls `createWritable`, and it never sets `keepExistingData`. The host parses a port message into checked ops and calls `Engine`; it does not touch files. Call chain for a write: façade → `Engine.commit` → `wal.publish` then `memtable.apply`. Reads: façade → `Engine.get` → memtable, then `sst.lookup`.

The tables package, when it exists, depends on `Db` alone. A primary row and its secondary index entries are extra byte keys in one `batch`, so they commit or roll back together. Ordered encoding of numbers, strings, dates, and compound keys lives entirely there. Live queries later are a notification from the same pump after apply, pushed on the existing port, not a second read path.

Interface depth: the six `Db` methods hide SharedWorker lifetime, fencing, group commit, the slab B-tree, WAL files, SST blocks, compaction, generations, pins, and Web Locks. A caller cannot name a level, seal, or choose a durability mode. There is one durability: the resolved promise. `prefixBound` stays public because the key is the public data model; it does not open storage.

## Synthesis decision

(single candidate; orchestrator fills)

## Tradeoffs accepted

- We accept a `postMessage` on every `get` and `put` in exchange for one memtable and cross-tab visibility as soon as the promise resolves.
- We accept one WAL `finish` per group, and a solitary `put` is a group of one, in exchange for a single durability mode. A resolved promise is recoverable by a fresh opener. There is no memtable-only acknowledgement.
- We accept seal and compaction slices on the SharedWorker thread in exchange for one agent that publishes OPFS files, so fencing stays a one-agent protocol.
- We accept a B-tree node arena and a byte slab, instead of a `Map` or a sorted array of objects, in exchange for logarithmic inserts and scans that do not allocate one object per key.
- We accept length-prefixed SST blocks, a block index, and no Bloom filter and no prefix compression, in exchange for one codec inside `sst.ts`. The index still range-reads one block.
- We accept an idempotency cap (provisional: 4096 keys, plus every key still in an unsealed WAL file) in exchange for keeping the manifest off the per-commit path. A retry after the cap has dropped the key is a new commit and can overwrite a later value.
- We accept `get` as latest-acknowledged and `range` as a snapshot from iterator start in exchange for point reads that stay fresh across awaits and scans that see each key once.
- We accept an epoch bump and a WAL copy-forward on every engine start in exchange for ignoring a zombie `close` that lands after recovery listed the directory.
- We accept TypeScript CPU and GC on the SharedWorker, including sliced compaction, in exchange for a package that ships as JavaScript: no WASM binary, no cross-origin isolation, no SharedArrayBuffer, and public values that are already `Uint8Array`, `Promise`, and `AsyncIterable`.
- We accept a second `checkBatch` at the SharedWorker in exchange for the engine never trusting a `MessagePort`. Both calls are the same function, which copies into fresh buffers and enforces the only limit table (key 8 KiB, value 16 MiB, batch 10_000 ops and 8 MiB). One batch fits in one seal.

## Alternatives considered

- **Dedicated WebWorker for seal and compaction, SharedWorker still the only manifest and WAL publisher.** The public `Db` would be identical, and latency spikes would be hidden better. It loses on ownership: a second agent would call `createWritable`, so "which file is published" becomes a cross-agent story on day one. The pump already yields between SST blocks; a second runner would be a second way to publish bytes. One OPFS writer is the smaller shape.
- **Main-thread-only engine.** The façade could stay small, but the page would host the memtable, jank on seal, and freeze with the tab. Two open tabs would be two writers of OPFS, which is the unresolved multi-writer protocol sitting under the import. Callers would be one step from opening files themselves. The SharedWorker is a different agent from the tab, so a frozen tab does not freeze commits, and the writer lock has a single holder without a leader election.
- **Per-tab dedicated WebWorker writers, SharedWorker only compacting.** This is independent tab writers with the UI kept off the hot path. `Db` can still look small, while epoch, WAL, and "read my memtable plus your unsealed files" become knowledge every tab's dedicated WebWorker and the compactor share. That is a shallow protocol under a deep façade, and it is split ownership of the committed generation. Per separate-before-serializing-shared-state, many writers would each own a memtable and merge at read. This design removes the second writer instead, because the SharedWorker can own the memtable without the freeze coupling that makes a tab-hosted leader fail.
- **One growing WAL, staged with `keepExistingData: true`.** Commit cost then tracks file size on Chromium's async OPFS path. Immutable WAL files, one per group, keep `finish` proportional to the group. `AsyncFs` has no append, so this shape is not a hidden option.
- **A `SharedArrayBuffer` memtable, or a caller-supplied comparator and JS values inside the engine.** The buffer needs cross-origin isolation and atomics, a second concurrency model, and an install story Dexie does not have. A comparator puts user code and Dexie types into the memtable, the SST codec, and compaction, and grows the public surface. The tables package encodes into bytewise keys and calls `batch` instead.

## Open questions and risks

- Is coalescing only the batches already queued (one macrotask so `Promise.all` across tabs can join) enough, or do real single-key workloads need a few milliseconds of extra delay before `finish`?
- Can an 8 MiB seal in TypeScript yield in small enough slices that queued commits stay inside a latency budget on the SharedWorker thread?
- Do Safari and Firefox keep a SharedWorker runnable while any tab of the origin is visible, and is `createWritable` / `close` from a SharedWorker durable there the same way it is on Chromium?
- Is a 4096-key idempotency cap enough for a tab that retries after a long seal and a burst of other commits, given a forgotten key can overwrite a newer value?

## Next implementation step

Build an in-memory `AsyncFs` with publish-on-`finish` semantics, the slab B-tree, WAL publish, and `Engine.recover` / `commit` / `get` against it, including a crash after WAL `finish` and before `memtable.apply`.
