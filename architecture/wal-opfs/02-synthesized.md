# Synthesized design: the WAL on OPFS

Status: contract for the prototype (2026-11-08). Grounding: `00-grounding.md`.
Candidates: `candidates/A-per-writer-*`, `candidates/B-shared-log-*`.

## Problem

Every acked write is one IndexedDB readwrite transaction (~195 µs, 244 µs p50
end to end), and every open replays the WAL at an IDB per-row cost. The only
OPFS write path that beats it is a SyncAccessHandle (SAH) in a dedicated
WebWorker: ~21 µs round trip from the main thread, without `flush()`. That gives
the same durability as today's relaxed IDB commit. The SharedWorker and the
main thread can read a log with `getFile()` while workers write it. A file
can't be removed while any SAH is open on it. The design must keep I1–I6 from
the grounding, and it should coordinate the way compaction does: private work,
short serialized installs.

## Usage (caller's view)

The public `Db` API does not change.

```ts
const db = await openDb({ name: "notes" });   // reads w/ segments with getFile; no IndexedDB
await db.put(k, v);                            // Web Lock + one SAH write in this tab's log worker
const n = await db.update([counter], ([cur], tx) => { … });   // body runs exactly once
await db.sync();                               // reads the log tail with getFile
await db.ingest();                             // seals the active segment, host folds it
```

Inside `DbImpl` the seam is `LogClient`:

```ts
const { seq, end, gap } = await this.log.append(this.cursor, ops);
const out = await this.log.update(this.cursor, (tail) => plan(tail));
const tail = await readLog(this.fs, this.cursor);   // sync / open; host ingest uses the same reader
```

## Shape

**Files** under `opfs-lsm/<name>/`:

```
w/<base:16>.wal  segment; base = first seq it holds
                 frames: u32 bodyLen | u32 crc(kind,seq,body) | u8 kind | u64 seq | body
                 kind 1 RECORD: body = encodeOps(ops)      kind 2 SEAL: empty body, seq = last record
m/<gen>.mft      manifest v2: runs, tombstoneSeq, walThrough   ← the commit point of ingest
```

**One rule for what is committed.** A record is committed when its frame is
whole, its CRC is valid, and its seq is the previous seq + 1. Readers scan from
a position and stop at the first frame that breaks the rule. So a torn tail is
invisible, and every reader sees a prefix of the log (I2).

**Append (log worker, under Web Lock `opfs-lsm-wal/<name>`).** The worker keeps
`end: LogPos` (segment, offset, seq) across lock holds, but only as a starting
point. Under the lock it:

1. Scans frames from `max(end, since)` to the real end, following SEALs. This
   covers frames other tabs wrote since this worker last held the lock, and any
   whole frame a dead holder wrote. The scanned bytes from `since` on are the
   `gap` the caller needs to catch up, so the scan is work the append needs
   anyway.
2. Overwrites torn junk at the end and truncates after it.
3. Group-commits every request queued while it waited for the lock: one
   `sah.write` for all their frames. If the segment would pass
   `segmentBytes`, it writes SEAL, closes that handle, creates `w/<seq+1>.wal`,
   and posts `{kind: "sealed"}` on the layers channel.
4. Releases the lock and replies `{seq, end, gap}` to each request.

**`update` takes one path.** The worker takes the lock, does step 1 and replies
with the tail, and keeps holding the lock. The main thread applies the tail,
runs the body once against its memtable, and sends the ops back (or none). The
worker appends them and releases the lock. This adds one hop over `put`, and
the body never re-runs.

**Readers use `AsyncFs` only.** `readLog(fs, from)` reads from a position to
the end of the chain with `fs.read` (`getFile` + slice), following SEALs. It
retries on `NotReadableError` and stops at the first frame that breaks the
rule. The same function serves open, `sync()`, and host ingest, so the worker
protocol carries only writes.

**Ingest works like compaction.** The commit point moves from the IDB pair
`(generation, ingestedThrough)` to the manifest, which now records
`walThrough`. The host:

1. Without a lock, reads the **sealed** segments above the latest manifest's
   `walThrough` with `readLog`. Sealed files never change, so these reads never
   throw `NotReadableError`.
2. Folds them and writes the L0, also without a lock.
3. Under the ingest lock (never the append lock), checks the latest manifest
   still has the same `walThrough`, and publishes `m/N+1` with
   `walThrough = last SEAL seq`.
4. Reclaims segments wholly at or below `walThrough`, best-effort. A remove
   that fails because a worker still has the handle open is retried on the next
   ingest. Workers close a segment's handle when they seal or pass it.

The trigger is a `sealed` broadcast, plus one `w/` listing when a tab starts
watching. The segment size is the policy: `segmentBytes = maxWalBytes`. The
host's `pendingBytes` bookkeeping goes away. `db.ingest()` asks its worker to
seal first.

**Switching generation.** A tab reads the manifest named by the `ingest` hint,
or the latest one. When `manifest.walThrough >= cursor.seq`, it installs the
generation, calls `advanceTo(walThrough)`, and moves its cursor to
`{segment: walThrough+1, offset: 0, seq: walThrough}`. Since ingest folds only
whole segments, `walThrough+1` is always a segment base.

**IndexedDB is removed.**

Interface depth: `LogClient` has three methods: `append`, `update`, `seal`. It
hides the lock, group commit, rotation, roll-forward, torn-frame repair, and
the worker wire protocol. `readLog` is one function. Frame codec and scan are
pure, and the writer runs over a synchronous `SegmentFile` interface, so Node
tests drive it on `MemoryFs` with an in-process mutex in place of the Web Lock.

### Crash table

| Crash after | State | Repaired by |
|---|---|---|
| part of a frame written | torn frame at the end, never acked | readers stop at it; the next lock holder overwrites it and truncates |
| frame whole, before the reply | committed, unacked (same as IDB `complete` before resolve) | readers apply it; the next writer scans past it |
| SEAL written, next file not created | sealed chain ends | the next writer creates `w/<seq+1>`; readers treat a missing next file as an empty tail |
| L0 written, before the manifest | orphan run, segments intact | garbage, as today |
| manifest published | **committed** | tabs switch on the hint or on the next sync; the next ingest reclaims |
| segments partly removed or still open | dead files | the next ingest retries the remove |
| power loss (no fsync) | possible hole mid-log | readers stop at the hole: still a prefix. Accepted per AGENTS.md (persistence is not guaranteed) |

Today's "L0 listed twice" row goes away, because `walThrough` and the run list
are published together.

## Synthesis decision

**Base: candidate B (one shared, totally ordered log).** Candidate A (per-writer
logs, Lamport stamps, merge on read) did take no lock on a single-key put, but
it still needed an exclusive barrier for `update`, for multi-key `batch` and for
the ingest cut. It also allowed a "long fork": two tabs could see two
concurrent writes in different orders. That breaks "consistency must be
guaranteed". Shared leases, yield broadcasts and causal `deps` were a lot of
mechanism for ~40 µs per put. B keeps I2 and I3 as they are, so the memtable,
`view` and fold don't change, and its ingest already copies the
compaction pattern the user asked for.

Changes to B:

- **Subtracted: the 32-byte hint.** The writer has to scan the gap anyway to
  return it, so the scan finds the end, and the hint's torn-hint and
  roll-forward rows go away. From the "one rule for what is committed" idea A
  and B shared.
- **Subtracted: the optimistic `update` path.** B's body could run twice. One
  locked path is a single way to do the task and costs ~40 µs more.
- **Subtracted: the worker `tail` message.** All reads go through `readLog`
  over `AsyncFs`, which open and ingest needed anyway. That leaves one reader.
- **Subtracted: `pendingBytes` counting.** The segment size is the ingest
  policy, and a seal is the trigger.
- **From A: closing handles.** The writer closes a segment's handle as soon as
  the segment is sealed, and reclaim is best-effort and retried. A's "delete
  when covered and sealed" rule, adapted to the probe's `removeEntry` finding.

## Tradeoffs accepted

- We accept one Web Lock per append (p99 tail ~725 µs) in exchange for unchanged I2/I3. Group commit amortizes it within a tab.
- We accept a dedicated WebWorker per `Db` (~10 ms spawn). It is the only place an SAH exists. The first write waits for it, and reads don't.
- We accept no fsync: a power loss can cut the log at a hole. Readers still see a prefix.
- We accept `update` holding the cross-tab lock while the main thread runs the synchronous body.
- Open replays up to about two segments (one sealed but not yet ingested, plus the active one), so up to ~2 × `maxWalBytes`.

## Alternatives considered

- **Per-writer logs merged on read (candidate A).** Less locking on blind puts, but weaker consistency (long fork) and a lease/barrier protocol callers' semantics depend on. Rejected above.
- **An elected leader worker with an exclusive SAH, which every tab's writes go through.** Two cross-context hops per write (~140 µs) plus a failover protocol. Not cheaper than the lock.
- **The async OPFS API (`createWritable`) on the main thread.** 0.7–2 ms per write, and slower as the file grows. Slower than IDB.

## Open questions and risks

- Does Chrome freeze a background tab whose worker holds the WAL lock, or the update lock across the main-thread body? A frozen holder stalls every writer.
- Is ~10 ms before the first write after open acceptable, or should the worker be spawned at module load?
- `NotReadableError` retries while reading the active segment under a heavy write stream: is a bounded retry enough?
- `collections` and the CRDT adapters rely on `ChangeEvent.seq`. It stays a global seq, so nothing should change. Worth confirming in the bench.

## Implementation notes (Phase D deviations)

Built on branch `proto/opfs-wal`. Five deviations from the sketch, none of
which changes the shape:

1. **Seal after the write, not before.** The sketch rotated before a write that
   would overflow, so a single large put into an empty segment never sealed and
   ingest never ran. The writer now seals once the segment reaches
   `segmentBytes`. That matches the old "ingest once the WAL passes
   maxWalBytes" policy, plus frame headers (~17 bytes per record).
2. **L0 names carry a nonce.** Two hosts folding the same sealed range wrote
   the same `l0/<first>-<last>.sst`, and the loser's cleanup would have removed
   the winner's live run. The cross-host ingest test found it.
3. **Log transport follows the fs, not the ingest owner.** An fs with
   in-process segments (MemoryFs) writes in-thread. Any other fs uses the
   dedicated WebWorker. Found by the `two-tab-local` Chrome proof (BrowserFs
   with an in-page EngineHost).
4. **The `ingest` hint names the generation.** Tabs load that manifest by name
   and list `m/` only when it is already gone, so a generation switch costs no
   directory listing.
5. **`host.ingest` folds sealed segments only**, because the SharedWorker
   cannot write an SAH. `db.ingest()` seals first. Tests that called the host
   directly now call `sealWal(db)` (`@opfs-lsm/kv/testing`) first.

Known costs left in the prototype:

- A `db.ingest()` seal also broadcasts `sealed`, so the host runs one extra
  empty fold attempt.
- A reply carries every frame from the caller's cursor. Group-committed
  appends from one tab each get a copy of the shared chunks over postMessage.
- `docs/design.md` still describes the IndexedDB WAL.

## Next implementation step

`log/frame.ts` and `log/writer.ts` over an in-memory `SegmentFile`, with unit
tests for the crash table. Then swap `IdBWal` out of `db.ts` and the host, and
measure `kv/fillsync`, `yjs/trace` and `ycsb-a` against `052e0b8`.
