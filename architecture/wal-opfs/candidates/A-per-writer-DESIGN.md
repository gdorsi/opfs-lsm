# Candidate A: per-writer logs, no shared sequencer

## Problem

The IndexedDB WAL costs ~200 µs per append because every append is a readwrite
transaction on one shared store, and that store also holds the global seq and the
atomic pair (`generation`, `ingestedThrough`) that tabs switch SSTs on. OPFS is fast
only through a SyncAccessHandle (SAH) in a dedicated WebWorker (~21 µs round trip),
and an SAH is exclusive per file, so a lock-free append means one log file per writer.
That removes the thing every invariant hangs on: one global, gapless seq (I2: "the
memtable is one exact prefix of the log"). The design has to say what order the
writes are in, how `update` stays serializable (I3), what replaces the IDB commit
point, and how tabs read each other's logs (main thread and SharedWorker can only
`getFile()`, which throws `NotReadableError` if the file changes underneath).

## Usage (caller's view)

The public `Db` API does not change. What changes is cost and one documented guarantee.

```ts
const db = await openDb({ name: "notes" });          // reads ready in ~SST load + 2–3 ms
await db.put(k, v);                                   // ~25–30 µs: one SAH append, no lock
await db.update([idxKey], ([prev], tx) => {           // epoch barrier: serializable
  tx.put(idxKey, bump(prev));
});
await db.batch((tx) => { tx.delete(a); tx.delete(b); }); // ≥2 keys: same barrier as update
await db.sync();                                      // reads every writer's log tail
```

Tab B after tab A's acked `put`: the value arrives over BroadcastChannel (~70 µs), or
`await db.sync()` reads A's log file directly. `view` pins a per-writer frontier.

## Shape

**Files** (one OPFS directory per db, no IndexedDB at all):

```
CURRENT                       u64 generation + crc. The commit point. createWritable swap.
m/<gen>.mft                   manifest + covers: Frontier + maxStamp
l0/g<gen>.sst, lN/...         unchanged runs
wal/<slot>/<firstLocalSeq>.log  one writer's segment, written only through its SAH
```

**Order.** Each open `Db` holds a *slot*: the lowest free `i < 256` whose Web Lock
`opfs-lsm-slot/<name>/<i>` it gets with `ifAvailable`, held for its lifetime. A slot's
log is a gapless `localSeq` sequence across incarnations. Every record carries a
`Stamp = lamport·256 + slot` (a unique JS-safe integer; the Lamport clock is raised past
every stamp the writer has applied) and `deps`, the writer's frontier when it wrote.
Conflicts resolve by highest stamp (LWW). Stamps replace seqs everywhere they are
compared today (`MemRow.seq`, `SstEntry.seq`, `tombstoneSeq`), so SST, merge and wasm
code are untouched.

**Replacing I2.** The memtable is the LWW fold of a *cut*: a `Frontier` (localSeq per
slot) that is (a) a prefix of every slot's log, (b) causally closed (a record applies
only when its `deps ≤ frontier`, else `sync()`), (c) atomic per batch. The fold does not
depend on apply order, so a `view` pins `(frontier, generation, chunks, levels)` and
sees exactly one cut. `Memtable.apply` checks `localSeq == frontier[slot] + 1` instead of
`seq == applied + 1`.

**Epoch lock** `opfs-lsm-epoch/<name>` is the only cross-writer coordination
(`wal/epoch.ts` owns both sides of it):

- *Lease* (shared mode): a writer appends only while holding it. It takes it lazily on
  the first write, keeps it across writes, and after every acquisition runs `sync()`
  before appending, which raises its Lamport clock past everything written before.
  It drops it on a `yield` broadcast (after in-flight appends ack), on `visibilitychange
  → hidden`, `freeze`, `pagehide`, and `close`.
- *Barrier* (exclusive mode): request the lock, broadcast `yield` (repeat every 50 ms
  until granted). Once granted, no log is moving. Web Locks queue a later shared request
  behind a pending exclusive one, so writers cannot starve it.

Barrier property: every record written before a barrier has a lower stamp than every
record written after it. Three users:

- **`update` (I3)**: under the barrier, `sync()` reads every log to its end, run `body`
  against memtable+SST, append one record with the next stamp, release. It sees every
  write acked before it from any tab, and every later write sorts after it: strictly
  serializable. Blind writers pay nothing per write; they pay one re-lease + sync on
  their next write after a barrier.
- **Multi-key `batch`** (≥2 distinct keys): same path, see Tradeoffs.
- **Ingest cut**: the host takes the barrier just long enough to `getFile().size` every
  live segment. That cut is causally closed and a stamp prefix by construction.

**Ingest and the commit point.** Host, under `opfs-lsm-ingest/<name>` as today:
barrier → measure ends → release (writers resume) → read and parse each slot from
`covers+1` to the measured end → sort by stamp, `foldRecords` → write `l0/g<G+1>.sst`
→ write `m/<G+1>.mft` with `covers = cut`, `maxStamp = max stamp folded` → swap
`CURRENT` → broadcast `ingest` → delete every segment whose last localSeq ≤ covers and
that is sealed or whose slot lock the host gets with `ifAvailable`. Because the cut is a
stamp prefix, every record outside `G` has stamp > `maxStamp(G)`: L0 runs stay ordered
newest-first by stamp and `pointGetSst`'s "first level that has the key wins" stays
valid. Compaction is unchanged except `installStep` swaps `CURRENT` instead of
`wal.raiseGeneration`; manifests carry `covers`/`maxStamp` forward.

A tab installs `G` with `mem.advanceTo(maxStamp(G))` (drop rows with stamp ≤ maxStamp,
exactly today's code with stamps) and `frontier = max(frontier, covers)`. The union of
two causally closed cuts is closed, so no extra check. There is no atomic pair to read:
a manifest describes its own cut, and logs only lose segments that `CURRENT` covers.

**Log format** (`wal/format.ts`, pure):

```
record = u32 bodyLen | u32 crc32(body) | body
body   = u8 kind(0 batch | 1 seal) | u32 localSeq | f64 stamp
       | u8 nDeps (0xFF = same as my previous record) | nDeps × (u8 slot, u32 localSeq)
       | ops (today's encodeOps bytes)
```

A record whose length runs past EOF or whose CRC fails ends the readable log (torn
tail, or an append in progress). The writer's dedicated WebWorker rotates at 64 KiB:
append a `seal` record, close the SAH, create `<nextLocalSeq>.log`, open a new SAH. A
new incarnation of a slot opens the last segment, truncates the torn tail, appends
`seal`, and starts a new segment at `lastValid+1` (or at `covers[slot]+1` if the host
deleted everything). Writers never reopen another incarnation's live segment.

**Reading other writers** (`wal/reader.ts`, used by tabs and by the host): per slot a
cursor `{segment, offset}`. `sync()` does one `getFile()` per known slot, reads
`slice(offset)` only when `size > offset`, parses, follows `seal` to the next segment,
and probes `wal/<maxKnownSlot+1>` for a new writer. `NotReadableError` → fresh
`getFile()` and retry. `NotFoundError` on a segment → it was ingested: read `CURRENT`,
install the newer generation, continue from `covers`. Records whose deps are not yet
applied trigger one more pass over the named slots; the deps were written before the
record, so a second pass finds them.

**Orphans.** A crashed tab's records are already committed and the host ingests them like
any other slot. Its slot lock is released by the browser; the next `openDb` that takes
that slot seals the old segment and continues the slot's log. The host deletes a dead
slot's fully ingested segments when it can take the slot lock with `ifAvailable`.

**Crash table.**

| Crash after | State on reopen |
|---|---|
| Record partly written | CRC/length fails; never acked; readers stop before it; next slot owner truncates it. |
| Record written, before ack | Committed and visible, caller saw no ack (today it would be absent). |
| Barrier granted, before release | Browser releases the lock with the dead context; writers resume. |
| L0 or manifest written, before `CURRENT` | Garbage. The next ingest recomputes `G+1` from `CURRENT` and overwrites both paths. |
| `CURRENT` swapped, before segment delete | Segments stay; readers skip records ≤ covers; next ingest deletes them. |
| Segment deleted under a reader | `NotReadableError`/`NotFoundError` → reader installs `CURRENT`. |
| Compaction output written, before `CURRENT` | Garbage, as today. |

**Cost per op** (grounding numbers; *est.* = not measured this session):

| Op | Path | Estimate |
|---|---|---|
| `put`/`delete`, lease held | encode+crc, SAH append round trip 21 µs, memtable apply, async broadcast | **~25–30 µs** (today 244) |
| first write after losing the lease | + lock 50–110 µs + `sync` | ~150–300 µs once |
| `update`, 1 tab | lock 50–110 + sync own log (est. 30–60) + append 21 | **~110–200 µs** (today 220) |
| `update`, 3 tabs | + yield 70 µs + other tabs' drain + 2 more log reads | ~300–450 µs; each other tab's next write +150–250 µs |
| `sync` | one `getFile` per slot (est. 30–60 µs) + slot probe + parse | ~60–100 µs (1 tab), ~150–250 µs (3 tabs) |
| `open` | slot lock, `CURRENT`+manifest+SSTs (as today), read ≤ maxWalBytes of segments (0.65 ms/MiB + parse) | reads ready at today's SST time + ~2–3 ms; worker spawn ~10 ms in parallel, first write waits on it |

## Tradeoffs accepted

- **We accept a weaker cross-tab order than today in exchange for lock-free appends.**
  Guarantees: atomic batches, per-writer order, causal closure, convergence by stamp,
  strictly serializable `update` and multi-key `batch`, and every SST generation is a
  prefix of the stamp order. *Not* guaranteed: two concurrent single-key writes from two
  tabs can become visible in different orders to two other tabs (a "long fork") until
  they catch up (~one broadcast hop). Today's single global prefix forbids this. Closing
  it needs either a sequencer (the other shape) or a reader watermark that stalls every
  reader on the slowest idle writer.
- **Multi-key blind batches take the barrier.** Without it, a reader can see batch X{k}
  without a concurrent lower-stamped Y{k,j}: `k=X, j=old`, a state no serial order
  produces. Single-key writes cannot produce that. We pay ~update cost for multi-key
  batches (bulk batches barely notice: 2 ms → ~2.3 ms).
- **`update` gets no faster, and gets slower with many writing tabs**, in exchange for
  blind writes 8–10× faster. Collections index maintenance is all `update`.
- **A write can survive a crash without its ack**, because the commit point is the bytes
  in the file, not a later event.
- **Barrier liveness depends on tabs answering `yield`.** A tab in a long task delays
  `update` and ingest by that long.
- **10 ms first-write latency after open** (worker spawn), in exchange for no per-write
  hop through any shared context.
- `ViewSnapshot.walHead` and `ChangeEvent.seq` keep their type but now hold a stamp
  (highest applied / the record's), not a gapless seq.

## Alternatives considered

- **Per-writer logs, pure HLC LWW, no epoch lock.** Zero coordination even for `update`
  (per-key Web Locks only). Lost: a blind put not yet visible to an `update` can carry a
  lower stamp and be silently overwritten (not serializable), and the ingest cut is not a
  stamp prefix, so reads would have to compare stamps across memtable and every SST
  level (every `get` probes every level, and compaction merges by stamp in wasm).
- **Per-writer logs with a reader watermark** (apply only records with stamp ≤ min over
  live writers). Gives one global prefix, but an idle tab freezes everyone's visibility
  and read-your-writes needs heartbeats. Exposes timing to every reader.
- **Commit-wait on physical time** (stamp = shared monotonic clock, wait out the
  uncertainty). Depends on cross-process clock comparability and coarsened timers;
  fragile assumption to hide.

## Open questions and risks

- Is the long-fork anomaly acceptable under "consistency must be guaranteed", given
  `update`, multi-key batches and every SST generation are prefix-consistent? If not,
  this shape loses to the shared-log candidate.
- Does Chrome hold off freezing a tab that holds a Web Lock, and is `freeze` reliably
  delivered before? If a frozen tab keeps its lease, `update` and ingest hang.
- `getFile()` + small `slice().arrayBuffer()` cost on the main thread is unmeasured; `sync`
  and `update` estimates hinge on it.
- Web Locks fairness (a new shared request waits behind a pending exclusive) is assumed
  from the spec's queue; verify in Chrome 156.
- 256 slots cap concurrent `Db` instances per name; the 257th waits for a slot.

## Next implementation step

Measure `getFile()` + `slice(offset).arrayBuffer()` on a 64 KiB segment being appended by
another context, then write `wal/format.ts` + `wal/reader.ts` with a two-writer torn-tail
test on `MemoryFs`.
