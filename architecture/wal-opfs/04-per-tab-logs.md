# Sketch: one log per tab, HLC stamps, session puts

Status: sketch (2026-11-08). Replaces the shared log of `02-synthesized.md`
if accepted. Driven by `03-cross-browser-probe.md`: outside Chrome a
SyncAccessHandle is always exclusive, so a file can't be shared between tabs
cheaply. A file that never leaves its tab can be.

## Guarantees

- **Session puts.** `put`/`batch` resolve once the frame is in the tab's own
  file. The tab reads its own writes at once.
- **Stable prefix.** Every tab sees other tabs' writes only as a prefix of one
  total order, the same order in every tab. Its own unstable writes sit on top.
  Per-key last-writer-wins, so a key never flips back.
- **`update` stays serializable**, with no lock (read at its own stamp, below).
- Writes take no lock and wait for nobody. Coordination moves to visibility:
  another tab's write becomes visible once every live tab has moved past it.

## Files

```
w/<tab>/<n>.wal   tab <tab>'s log, segment n. Only that tab's worker opens it
                  (exclusive SAH, held for the tab's life, never handed off).
                  frames: u32 len | u32 crc | u8 kind | u64 stamp | u32 fileSeq | body
                  kind RECORD (ops) | PROMISE (no body) | SEAL
m/<gen>.mft       manifest: runs, tombstoneSeq, cut {stamp, tab}, seqThrough
```

Within a file, the commit rule is unchanged: a frame counts when it is whole,
its CRC is valid, and its `fileSeq` is the previous + 1. Stamps never
decrease within a file.

## Order: HLC stamps

`stamp = ms * 4096 + counter` (53 bits, a safe JS integer), and
`stamp = max(clock, highest stamp seen, own last + 1)`. Ties across tabs
break on the tab id, so the global order is `(stamp, tab)`. The HLC keeps
busy tabs' stamps rising with the shared OS clock, so stamps from active tabs
move the watermark forward without extra messages.

## Visibility: the watermark

A tab's **promise** is the stamp of its last frame: it never writes below
it. To move its promise without writing data, a tab appends a PROMISE frame
(3–45 µs).

- **Live tabs** are the holders of the Web Locks `opfs-lsm-tab/<name>/<tab>`,
  listed with `navigator.locks.query()`. A tab holds its lock for its whole
  life, so a crash releases it (probe: about 5 ms). A dead tab's file is
  final, so it doesn't hold the watermark back.
- **Watermark W** = min over the other live tabs of their promise, capped at
  its own next stamp − 1. Records with `(stamp, tab) ≤ W` from all files,
  merged in order, are the **stable prefix**.
- The fast path is a broadcast. After each append the tab broadcasts
  `{tab, stamp, ops}`. Messages from one sender arrive in order, so each one
  is also that tab's latest promise. Files are the fallback: open, a missed
  message, or a new tab.
- **Idle tabs.** A tab with buffered foreign records above W broadcasts
  `advance(s)`. Idle tabs append a PROMISE at their current clock and
  broadcast it. With two tabs this is rarely needed, because the writer's own
  message already moves its promise.
- **Joining.** A new tab takes its lock, then reads every file's last stamp,
  and starts its HLC above all of them, then writes a PROMISE. Any watermark
  computed before it held the lock is below those stamps. Any computed after
  waits for its first frame.

## The engine below keeps integer seqs

The stable prefix is deterministic: the same records in the same order in
every tab. So each tab numbers it `seqThrough + 1, + 2, …` from the manifest
and gets the same seqs as every other tab. The memtable, views, SST fold,
compaction and `tombstoneSeq` therefore still see gapless integer seqs
(I2/I3 intact). New parts:

```ts
type Stamp = number;                       // HLC, 53-bit
type TabId = string;
type Order = { stamp: Stamp; tab: TabId }; // global order key

/** One tab's view of every log. Pure; fed by broadcasts and file reads. */
interface Merger {
  /** A record or promise from another tab, in that tab's file order. */
  observe(tab: TabId, frame: { stamp: Stamp; ops?: CheckedOp[] }): void;
  setLive(tabs: ReadonlySet<TabId>): void;
  /** Records that became stable, in order, numbered from `seqThrough`. */
  drainStable(ownNext: Stamp): WalRecord[];   // WalRecord = { seq, ops }, unchanged
}

/** The tab's own unstable writes: read before the memtable, dropped once stable. */
interface OwnOverlay {
  add(stamp: Stamp, ops: CheckedOp[]): void;
  get(key: CheckedKey): Row | undefined;
  dropThrough(w: Order): void;
}

interface TabLog {                         // the per-tab dedicated worker; no lock
  append(stamp: Stamp, ops: Uint8Array): Promise<void>;
  promise(stamp: Stamp): Promise<void>;
  seal(): Promise<{ segment: number; through: Order }>;
}
```

The read order is overlay, then memtable (the stable prefix), then SSTs.

## `update`: read at its own stamp

1. Pick `t` = the next HLC stamp, and broadcast `advance(t)`.
2. Wait until W ≥ t. With a single tab this doesn't wait.
3. Run the body once against the stable prefix through t, plus the overlay.
4. Append the result at stamp `t`.

Every write ordered before `t` is in the read, and every write after it is
ordered after the update. So there are no lost updates and no lock. Two
concurrent updates serialize by stamp. They can't deadlock: a tab waiting to
write at t₂ can still promise t₂ − 1.

## Ingest, like compaction

The SharedWorker reads the tabs' **sealed** segments with `getFile`. It
computes W from the files and `locks.query()`, and picks a cut C ≤ W at a
segment boundary. It folds the stable records ≤ C into an L0, with no lock.
Under the ingest lock, it publishes a manifest with `cut = C` and
`seqThrough`. It removes sealed segments that are wholly ≤ C. A tab seals a
segment when the segment reaches `maxWalBytes` and broadcasts `sealed`.
Ingest never touches a file a tab has open.

## Costs and risks

- **put**: stamp, round trip, held write. No lock. Estimates: Chrome ~25 µs,
  Safari ~25 µs, Firefox ~60 µs.
- **A frozen live tab stalls the watermark.** Every tab stops seeing others'
  new writes, and `update` waits. Its own puts keep working. Today only a
  frozen lock holder stalls anything. To check: does Chrome or Safari freeze
  a page that holds a Web Lock?
- **Opening reads one file per tab** (live and recently dead) and merges them.
- **`ChangeEvent.seq` for the tab's own put** isn't known at ack time. It's
  assigned when the write becomes stable. Collections and the CRDT adapters
  must be checked.
- **Clocks**: the HLC tolerates skew between tabs. Correctness rests on the
  promise and join rules, not on synchronized clocks.

## As built (2026-11-09)

The prototype in `packages/kv/src/log/` differs from the sketch above in
these places. Where they disagree, this section is current.

- **Files.** `w/<tab>/<firstN:10>.<prevStamp:16>.wal`. Frame:
  `u32 len | u32 crc | u8 kind | u64 stamp | u32 n | body`, kinds RECORD and
  SEAL only. A frame counts when it is whole, its CRC holds, its `n` is the
  previous + 1 and its stamp rises. The name lets a reader resume after
  reclaimed segments, and lets recovery check that the logs still cover a
  manifest's cut.
- **Stamps are microseconds.** `stamp = µs since 2025 × 4 + counter`, safe
  until 2096. Writes of tabs that never saw each other order by wall clock
  to `performance.now()`'s resolution (5–100 µs in browsers), then tab id. A
  frame whose stamp is not a safe integer ends the log prefix.
- **No PROMISE frames.** Promises travel only on the BroadcastChannel:
  `advance(s)` asks, `promise(stamp, n)` answers, and `rec` carries each
  record. A file read is the fallback for a gap, a join and a dead tab. A
  stalled tab repeats its `advance` every 50 ms, marked `again`, and each
  tab answers a repeat with its last promise even when it promised nothing
  new: a lost promise is in no file. A lost `rec` shows up as a gap in `n`.
  **Without BroadcastChannel a second tab waits forever** (open
  limitation; a PROMISE frame plus polling would lift it).
- **Join.** A new tab broadcasts `hello`; each live tab answers `welcome`
  with its stable stamp and promise, and holds its watermark until the new
  tab promises.
- **`sync` ends the overlay.** It reads every log and waits until every
  record it saw from another tab, and every record this tab wrote, is
  stable. Reads after it are one prefix of the order, with nothing of this
  tab's on top, so they include any write of another tab ordered before
  this tab's own.
- **Open runs in parallel.** The liveness lock and the log reads start at
  once, alongside the manifest read and the generation load. The scan
  waits for the manifest's cut and passes over the records under it
  without decoding them or checking their CRC (the ingest that folded them
  checked it). No record is handed out until the generation is installed.
  The live-tab query runs after the reads, and each tab not live is read
  again before it stops holding the watermark back. If the manifest's runs
  turn out to be gone and an older generation stands in, the logs are read
  again above its lower cut.
- **Flush before broadcast, flush on demand.** A tab broadcasts a record
  only once it is durable, so after a power loss no tab's state depends on
  a record that was lost. A SyncAccessHandle flush costs ~0.4 ms in Chrome,
  ten times a write, and blocks the next write. So flushes run at once when
  another tab asks (`advance`) for a stamp that an unflushed record holds
  back, after 2 ms while other tabs are live, after 100 ms when alone, and
  before an ingest or a close.
- **Ingest.** A tab counts stable bytes above the generation's cut. Past
  `maxWalBytes` it makes its own records durable, then sends
  `ingest-request` with a cut that covers them. It asks again only once
  another `maxWalBytes` is waiting, which retries a lost request or a
  failed ingest. The host folds every tab's records ≤ cut, publishes a
  manifest with `cut` and `through`, and removes segments wholly ≤ cut (and
  the directory of a dead tab once empty). A host ingest with no cut uses
  the lowest last stamp among live tabs: it reads the logs' last stamps
  first and queries the live tabs after, and a live tab with no record in
  what it read holds the cut where it is. Queried the other way round, a
  tab that joined in between could write below the cut after the fold.
- **A torn frame only ends the last segment.** A segment is sealed and
  flushed before the next one is made, so a reader that finds a bad frame
  in a segment with a later one, or a next segment that does not follow on
  (its `firstN` and `prevStamp`), throws `CorruptDatabaseError` rather than
  drop the records past it.
- **A read past reclaimed segments waits for their generation.** A tab
  that missed records (lost broadcasts, a missed `ingest`) can find their
  segments reclaimed. The next segment's name gives the `n` and stamp
  before it, so the read goes on, but the tab hands out nothing more until
  it installs a generation whose cut reaches that stamp, or it would number
  what follows too low. It loads the newest; if even that does not reach
  the stamp, the records are gone and it fails with `CorruptDatabaseError`
  (a deleted first segment, or an emptied newest manifest whose reclaim
  ran).
- **A dead tab's log ends in a tombstone.** Reclaim used to remove a dead
  tab's whole log once the committed cut covered it. Then recovery (an
  older manifest standing in after a power loss) and a tab that had missed
  the records (lost broadcasts) both took it for a tab that never wrote:
  silent loss, found by the multi-tab model (lost update) and shown for
  recovery by a regression test. Now
  the last segment gives way to an empty one named past its last record,
  removed once every manifest on disk covers it. A tab retiring a dead tab
  whose log is gone altogether installs the newest generation first.
- **A tab whose log fails leaves.** A failed write or flush (quota) used to
  leave the tab live but unable to promise past what it wrote, so every
  other tab's `ingest` hung. It now says `bye` and releases its lock, and
  its writes fail with the error. Under quota Chrome's
  `SyncAccessHandle.flush()` can also block the log worker forever (seen
  in the kill loop: the worker never received its next message), so a
  flush past 5 s fails the log and terminates the worker.
- **Open: a rare lost key after a browser crash.** Twice in about 250
  kill-loop iterations, keys written and ingested by the check right after
  a `browser-crash` were gone after the next iteration, with the files
  checking clean. Not explained yet (docs/verification.md).
- **Not a quota hang after all.** The `quota` kill-loop iterations that
  hung were `ingest()` flushing until nothing was unsent while a tab kept
  writing; it now flushes only what was appended before it was called.
  After that fix, 20 of 20 `quota` iterations passed, and every write
  under quota failed with an error ("No space available", "exceed its
  storage quota") instead of blocking.
- **Recovery.** The newest intact manifest wins. An older one stands in only
  while the logs still hold everything above its cut. Open trusts the
  newest manifest and checks runs only on the retries, under the reclaim
  lock, where a missing run means it never reached the disk.
- **Records travel on their own channel.** Sessions share `rec`, `promise`,
  `advance`, `hello`, `welcome` and `bye` on `logChannel`; only
  `ingest-request` and `ingest` notices go on `layersChannel`, where the
  `Db` and the SharedWorker host listen. On one channel, every record's ops
  were cloned into the tab's own `Db` listener and into the host, which
  dropped them: about 80 ms of the tab's main thread per 100k ops, and host
  time taken from ingest. The split took `fillrandom` from 300k to 381k
  ops/s and `fillseq` from 386k to 543k in Chrome (main: 340k and 472k),
  and the p99 batch from 21 ms to 7.5 ms. A tab alone still clones each
  record once to post it (about 33 ms per 100k ops); skipping that while no
  other tab is live is a follow-up.
- **Change events.** A tab's own write carries its `seq` only if it was
  already stable at ack time; otherwise the event comes when it becomes
  stable.
- **A suspended page leaves, then joins again as a new tab.** A frozen or
  back/forward-cached tab promises nothing, so it held every other tab's
  watermark until its lock went. Chrome 133+ Energy Saver skips freezing a
  tab whose Web Lock others wait on, but the tabs only query the locks, and
  Safari caches pages that hold Web Locks. Now `freeze` and `pagehide` with
  `persisted` make the tab leave as on close: it waits for writes in flight
  and a granted `update`, says `bye` and releases its lock, then flushes and
  closes its log worker. With nothing in flight the lock goes before the
  page stops. On `resume` or `pageshow` the `Db` joins again as a new tab
  with a new log. The new tab starts above what the old one handed out and
  takes over its overlay. The old log is read like any dead tab's, so its
  records join the order. Writes made while away wait for the join. Left
  open: a page frozen with a write in flight holds the others until it
  resumes, and a `Db` in a worker has no page events.

## Rejected here

- **Stamps without a watermark** (candidate A's approach). Two tabs can see
  concurrent writes in opposite orders (long fork).
- **Strict puts.** They would keep today's guarantee, but each put would wait
  on every other tab. Rejected by the user in favour of session puts.
- **A SharedWorker sequencer.** One hop per write, a gap that stalls readers
  when a tab dies holding a seq, and counter recovery when the SharedWorker
  restarts.
