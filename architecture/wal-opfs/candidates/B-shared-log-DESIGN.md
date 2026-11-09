# Candidate B: one shared, totally ordered log on OPFS

## Problem

The WAL is one IndexedDB database. A single awaited `put` costs 244 µs p50, and IDB's
transaction is doing three jobs: it assigns gapless seqs, it is the commit point of an append,
and it reads `(generation, ingestedThrough)` together with the tail so a tab switches SST
generation atomically. On OPFS, the only fast write path is a SyncAccessHandle (SAH) in a
dedicated WebWorker (~3 µs in-worker, ~21 µs round trip from the main thread). The
SharedWorker and the main thread can only `getFile()`. Readers get `NotReadableError` if the
file changes during a read. This design keeps a single global log with gapless seqs, so I2 ("the
memtable is one exact prefix of the global log") and I3 (`update` is serializable) hold as they do
today, and `Memtable`, `view`, and fold stay as they are. It replaces each of the three IDB jobs
with something compaction-shaped: a short critical section, and work done privately.

## Usage (caller's view)

The public `Db` API does not change. One behaviour changes: `update`'s `body` may run twice, at
most (see Shape).

```ts
const db = await openDb({ name: "notes" });      // ~1 ms log read (+ memtable apply); no IDB
await db.put(k, v);                               // ~70 µs p50: one Web Lock + one SAH write
const n = await db.update([counter], ([cur], tx) => {          // pure body: may re-run once
  const next = (cur ? u32(cur) : 0) + 1; tx.put(counter, u32b(next)); return next;
});
await db.sync();                                  // ~25 µs: one round trip to this tab's log worker
```

Internal call sites (the seam `DbImpl` sees):

```ts
const r = await this.log.append(this.at, ops);                     // blind batch
const r = await this.log.appendAfter(this.at, (tail) => plan(tail)); // update
const t = await this.log.tail(this.at);                            // sync
```

## Shape

**Files** under `opfs-lsm/<name>/`:

```
w/<base:16>.wal   segment; base = first seq it holds; next segment's base = SEAL.seq + 1
  [0..32)  hint    magic | headSeq u64 | end u32 | sealed u8 | crc u32   (a hint, never the truth)
  [32..)   frames  u32 bodyLen | u32 crc | u8 kind | u64 seq | body
           kind RECORD: body = encodeOps(ops), seq = the record's seq
           kind SEAL:   body empty, seq = last RECORD seq; terminal frame of the segment
m/<gen>.mft       manifest, now with `walThrough` (was IDB ingestedThrough)
```

**Commit point of an append = a complete frame with a valid CRC, and seq = previous + 1.**
Readers never look at the hint. They scan frames from their cursor and stop at the first frame
with a bad CRC, at a seq gap, or at the end. The hint exists so a writer finds the end in O(1).

**Append protocol** (the log worker, under Web Lock `opfs-lsm-wal/<name>`, `appendLocked` in
`log/segment.ts`):

1. Read the 32-byte hint (`sah.read`, ~1 µs). If the CRC is bad (torn hint, or a power loss),
   scan frames from 32 to find the end.
2. **Roll forward.** While the frame at `hint.end` is valid with `seq = hint.seq + 1`, advance.
   That frame was written by a holder that died before it updated the hint, so it is committed.
   If the frame is SEAL, the segment is sealed: never write to it again. Open `w/<seq+1>.wal`,
   creating it if it is missing (the name makes this idempotent).
3. **Repair.** Anything at `end` that is not a valid frame is a torn frame from a dead holder.
   It is overwritten in step 4 and truncated after it.
4. **Group commit.** Every request queued while waiting for the lock gets the next seq. Their
   frames are concatenated into one `sah.write(at = end)`, followed by `truncate(newEnd)` if the
   file was longer (torn junk), then one hint write. If `end + bytes > SEGMENT_BYTES` (256 KiB =
   maxWalBytes/4), write SEAL first, create the next segment, and write there.
5. Release the lock, then reply to each request with `{seq, end, gap}`. `gap` holds the frames
   in `(since, seq)` that other tabs wrote, read from the SAH while the lock was held, so the
   caller reaches its own record without calling `sync()`.

Under the lock: one hint read, one frame write, one hint write. No async OPFS call except on
rotation (every 256 KiB). All segment handles are `mode: "readwrite-unsafe"`, so every tab's
worker can hold the active segment open.

**`update()` = optimistic, then locked.** `appendAfter(since, decide)`: (a) main runs `decide`
against its memtable and sends `{expectHead: since.seq, ops}`. Under the lock, the worker writes
only if `head == expectHead`; otherwise it replies `conflict` with the tail. (b) On conflict, main
sends `lockedTail`. The worker takes the lock, reads the tail, replies, and **keeps the lock**
until main sends `lockedCommit(ops | abort)`. Main applies the tail, runs `decide` once more, and
replies. Serializability holds the way IDB's `appendAfter` gives it: the body's reads and the
append share one lock hold. The body runs at most twice. Path (a) costs the same as `put`. Path
(b) adds one lock and two hops (~+110 µs). The lock belongs to the worker in both paths, so a
dying tab releases it.

**Generation switch: the manifest is the commit point.** `GenerationMeta` gains `walThrough`.
The latest manifest is the atomic pair. Ingest is shaped like compaction: the host reads
**sealed** segments above `walThrough` with `getFile` (sealed segments are immutable, so they
never throw `NotReadableError`), folds them privately with no lock, and writes the L0. Then,
under the ingest lock (never the append lock), it publishes `m/N+1 {runs, walThrough: SEAL.seq}`.
It then posts `{kind:"ingest", generation}` and reclaims every segment with `base ≤ walThrough`,
best-effort, the same way `reclaimRuns` does. Ingest folds only whole sealed segments, so
`walThrough + 1` is always a segment base. A tab that jumps forward derives the segment name
and lists nothing. `db.ingest()` asks its worker to `seal()` first, then calls
`host.ingest(through = sealedSeq)`. The host's `pendingBytes` becomes derived: sizes of sealed
segments, from `seal` hints and from one `w/` listing on `watch`.

**Readers.** `sync()` sends the tab's cursor `{segment, offset, seq}` to its worker. The worker
reads new bytes with `sah.read` and no lock (~3 µs), stops at a torn frame or at SEAL (then
follows to the next base), and transfers the bytes back. An acked frame was written in full
before its ack, so I1 holds without the lock. Main decodes (`scanFrames`) and applies. Open
reads with `getFile` on the main thread, because the ~10 ms worker spawn runs in parallel. Each
segment is one `slice(offset).arrayBuffer()`. On `NotReadableError` it retries 3 times, then
waits for the worker. Generations arrive by the `ingest` hint, which carries the number, and
`load(gen)` reads that manifest. If the cursor's segment is missing, the tab loads the latest
manifest and jumps, as `catchUp` does today when it is `behind`.

**Cross-tab (I1).** The broadcast stays `{kind:"append", seq, ops, end}`. `end` advances the
receiver's cursor. A gap triggers `sync()`, as today.

**IndexedDB is removed entirely.** The WAL moves to segments, `generation` and `ingestedThrough`
move into the manifest, and `pendingBytes` becomes derived. `idb/` is deleted.

**Depth.** `LogClient` has four methods (`append`, `appendAfter`, `tail`, `seal`) and hides
locking, group commit, rotation, torn-frame repair, roll forward, worker vs `getFile` reads, and
the wire protocol. `DbImpl` keeps its cursor next to `mem.appliedThrough`. Frame and hint codecs
and `appendLocked` are pure functions over a synchronous `SegmentFile` (the SAH shape), so Node
tests run them on an in-memory file (per boundary-discipline).

### Crash table

| Crash after | State | Who repairs |
|---|---|---|
| mid frame write (tab dies, lock auto-released) | torn frame at `end`, never acked | readers stop at it; next holder overwrites it and truncates the junk |
| frame written, before hint | committed, never acked (same as IDB `complete` before resolve) | next holder rolls the hint forward; readers already apply it |
| SEAL written, before next file | sealed, next segment missing | writers create `w/<seq+1>` (idempotent); readers treat a missing next file as an empty tail unless `walThrough ≥ base` |
| next file created, before its hint | size 0 | writer initializes the hint; readers see no frames |
| hint torn | hint CRC bad | writer scans from 32 (≤256 KiB) |
| L0 written, before manifest | orphan run; segments intact | garbage, as today |
| manifest `m/N+1` published | **committed**; old segments still on disk | tabs install on the hint, or on a missing segment; the next ingest re-reclaims |
| segments partly reclaimed (or blocked by an idle tab's open handle) | dead files | the next ingest deletes every `base ≤ walThrough` |
| power loss (no fsync) | possible hole mid-log | readers stop at the hole (still a prefix). On its first lock hold, each worker validates `w/<walThrough+1>…` (~1 ms once per tab), truncates at the first bad frame, and deletes later segments |

Today's "L0 listed twice" crash row goes away, because `walThrough` and the run list are
published together.

### Estimated cost per op (grounding numbers, Chrome 156)

| Op | Today | B | From |
|---|---|---|---|
| `put` (idle) | 244 µs p50 | **~70 µs p50**, p99 ~750 µs (Web Lock tail) | lock+SAH round trip 65 µs + encode/apply/broadcast |
| `put`, N concurrent in one tab | N × lock | 1 lock per group | group commit |
| `update` | 220 µs | **~70 µs** no conflict; ~180 µs on conflict | (a) = put; (b) + lock + 2 hops |
| `sync`, nothing new | IDB readonly tx (~100+ µs) | **~25 µs** | 21 µs hop + 3 µs SAH read |
| open, 1 MiB uningested | 14–23 ms IDB read + apply | **~1 ms read** + unchanged memtable apply; first write waits for the worker (~10 ms after open starts) | getFile 1 MiB = 0.65 ms, 4–5 files |

## Tradeoffs accepted

- We accept one Web Lock per append, with its 725 µs p99 tail, in exchange for unchanged I2/I3
  semantics and no merge-on-read. Group commit amortizes it within a tab only.
- We accept that `update`'s body may run twice in exchange for one hop on the uncontended path.
  It must be pure. It already has to be synchronous.
- We accept a dedicated WebWorker per Db (~10 ms spawn, memory) because it is the only SAH host.
- We accept that a tab which misses an `ingest` hint keeps an old generation and a growing
  memtable. That costs memory, never correctness. A size cap that lists `m/` is the backstop.
- Ingest boundaries follow seal boundaries, so `db.ingest()` writes a small segment. This buys
  segment names derived from the manifest, with no listing.
- Memtable rows are views into reply buffers. A buffer stays alive while any of its rows does
  (bounded by `maxWalBytes`).

## Alternatives considered

- **Head counter as the commit point** (a header write after the frame, which readers must
  respect). Two writes are both required, a torn header loses committed data, and readers need
  the header and body from one snapshot, so they hit more `NotReadableError`. Making the frame
  the commit point needs one write, and the hint is free to be wrong.
- **In-band INSTALL frames** carrying the generation, so `sync` sees generation switches in log
  order. Rejected because the SharedWorker can't write an SAH, so the host would have to route
  each install through some tab's worker and depend on that tab staying alive. The manifest with
  `walThrough` is already atomic, and the host already writes it.
- **A `CURRENT` pointer file** read on each `sync`. It adds an async read (~100 µs+) to every
  sync and a race between tail and pointer. The manifest plus the hint gives the same thing
  without it.
- **A single elected leader worker with an exclusive SAH** (no lock per write). Every other
  tab's write costs two cross-context hops (~140 µs), and leader failover is a protocol of its
  own. That is not cheaper than the lock and is harder to get right.

## Open questions and risks

- **Biggest risk:** can `getFile()` on main and in the SharedWorker coexist with
  `readwrite-unsafe` handles, and does `removeEntry` fail while an idle tab's worker holds a
  sealed segment open? The grounding measured only exclusive SAHs. Probe both before building.
- Is a body that runs at most twice acceptable for `@opfs-lsm/collections`' index maintenance,
  or must path (b) be the only path (~+40 µs on every update)?
- Does Chrome freeze or discard a background tab whose worker holds the Web Lock? A frozen
  holder would stall every writer.
- Open applies the tail on main. Is ~10 ms before the first write acceptable, or should open
  pre-spawn the worker from a module-level promise?
- The `NotReadableError` retry at open can starve under a heavy write stream. Is falling back to
  the worker after 3 tries enough?

## Next implementation step

Write `log/frame.ts` and `log/segment.ts` (`appendLocked` over an in-memory `SegmentFile`).
Unit-test every row of the crash table first, then probe `readwrite-unsafe` + `getFile` +
`removeEntry` in Chrome.
