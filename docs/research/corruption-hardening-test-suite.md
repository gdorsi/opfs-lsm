# A test suite that keeps corruption out of `@opfs-lsm/kv`

Question: we are moving into hardening. How do we build a "battle-tested" test suite that brings
the risk of corruption bugs as close to zero as we can?

Status: research only. No source code changed. Sources were read on 2026-11-06. Claims about
this repo cite file paths. Claims about other systems link to the owner's own docs, source, or
paper. Anything I could not confirm against a primary source is marked **(unverified)**, and
anything I reasoned out without a source is marked **(inferred)**.

## Summary and ranked recommendation

The engine already has good point checks: 3,318 lines of vitest unit tests over
`MemoryFs` and `fake-indexeddb`, four small exhaustive models (`formal:kv`), and a real-Chrome
two-tab drive in CI. None of these generates long random histories, injects faults, crashes the
engine at every write, or checks the database against an oracle afterwards. Those four
techniques are what find corruption bugs in mature engines: SQLite
([testing.html §3](https://sqlite.org/testing.html)), FoundationDB
([testing](https://apple.github.io/foundationdb/testing.html)), TigerBeetle
([VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md)) and
RocksDB ([Stress test](https://github.com/facebook/rocksdb/wiki/Stress-test)).

Ranked by bugs caught per unit of effort:

1. **Write down the oracle and build it once.** A reference model is a `Map` plus the global seq
   log. Every check below compares against it. The engine exposes a gapless global seq per
   batch, so a read can be checked *exactly* against "the fold of some log prefix". This needs
   no general linearizability search. It is the cheapest high-value piece.
2. **Add an on-disk invariant checker** (`checkDatabase(fs, wal)`), the analogue of SQLite's
   `PRAGMA integrity_check`. It walks every manifest and run with CRC, ordering, level-disjointness
   and seq rules, and cross-checks IndexedDB `meta`. Every other test calls it at the end.
3. **Run a seeded, model-based random test in Node** with `fc.commands` and `fc.asyncModelRun`
   over several `Db` handles that share one `EngineHost`, one `MemoryFs` and one IndexedDB.
   Commands cover put, delete, batch, update, get, range, view, sync, ingest, compaction, close
   and reopen. fast-check shrinks a failure to a minimal command list and replays it from a seed
   ([model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)).
4. **Add a fault-injecting `AsyncFs` and a WAL seam, then enumerate crash states.** Record
   every durable operation (OPFS publish or remove, IndexedDB commit), crash after each one,
   and reopen. This is SQLite's TH3 crash test and RocksDB's `FaultInjectionTestFS` reduced to
   this engine's two stores. It is the only way to test the "Crash behavior" table in
   `docs/design.md` instead of trusting it.
5. **Model the two stores as independently durable.** Under power loss, an IndexedDB commit
   and an OPFS file swap are not ordered with respect to each other **(inferred)**. Some
   ingest and compaction step orders may then reopen to a non-prefix state or an unopenable
   database. See [Risks to target first](#risks-to-target-first).
6. **Fuzz the decoders**: `cargo fuzz` on `engine-core` (`decode_sst`, `scan_block_contains`)
   and byte-mutation property tests on the TypeScript SST reader, manifest decoder and WAL row
   decoder. Corrupt bytes must raise `CorruptDatabaseError` and never a wrong answer, a hang,
   or an out-of-bounds read. SQLite holds itself to this for malformed files
   ([§4.2](https://sqlite.org/testing.html)).
7. **Kill real Chrome** mid-ingest and mid-compaction with CDP (`Page.crash`,
   `Target.closeTarget`, `kill -9`), then reopen and run the checker. This is the only proof that
   the platform assumptions hold. MemoryFs cannot provide it.
8. **Run it for a long time and measure it.** Run a nightly seed sweep and soak in CI with
   seeds logged, run the suite in both wasm and TypeScript-fallback mode, and run StrykerJS
   mutation testing over `store/` and `host/` to find code the suite does not check.

Items 1 to 4 are a few days of work on Node with no browser. They cover the components where a
bug corrupts data: ingest, compaction install, reclaim, memtable `advanceTo`, view pins, and the
merge order.

## Decisions (2026-11-06)

1. **Crash contract.** Losing recent acked writes on crash or power loss is acceptable; it is
   outside the engine's control. Corruption is not: after any crash the database must open, and
   its state must be the fold of a prefix of the log. A test that reaches a non-prefix state or
   an unopenable database has found a bug, not an accepted limit. This makes
   [Risks to target first](#risks-to-target-first) items 1 and 2 bugs to fix if confirmed.
2. **SST CRC in tabs stays skipped.** The engine does not defend against tampering, and data in
   the browser is untrusted anyway. Decoder fuzzing therefore requires no hang, crash or
   out-of-bounds read on corrupt bytes; a wrong answer from a corrupt SST read in a tab is
   accepted.
3. **Seams live in the test harness first.** Change production code only when a harness-side
   approach is not feasible or would make tests flaky. For the WAL, try replacing
   `globalThis.indexedDB` with a fault-injecting wrapper over `fake-indexeddb` before adding a
   constructor parameter.
4. **New dev dependencies are fine:** fast-check, `cargo fuzz`, Jazzer.js, StrykerJS.

## What exists today

| Asset | What it covers | Gap |
|---|---|---|
| `packages/kv/tests/*.test.ts` (29 files) | Example-based unit tests: SST format, LZ4, bloom, memtable, WAL append/read/ingest, view, update, compaction, generation, close race | Hand-picked cases. Two tests use a seeded LCG (`lz4.test.ts`, `memtable.test.ts`). No random histories, no oracle, no fault injection. `sst.test.ts` has one "rejects corrupt crc" case. `wal-read.test.ts` has two corrupt-row cases. |
| `packages/kv/formal/` (`formal:kv`) | NoLostAcks, WalOverSst, ViewPin, CompactPreserve as exhaustive BFS over tiny domains, plus source-sync guards (`.agents/skills/verify-kv/SKILL.md`) | The skill states its own bounds: 1 key and 2 appends for ingest, at most 2 runs for compaction. It omits crashes, multi-tab, reclaim against a view, and `pendingBytes`. Its "Not covered yet" list is the right next target list. |
| `verify-opfs-lsm` drives (`two-tab`, `kv-bench`, …) | Real Chrome, SharedWorker, OPFS, cross-tab visibility (`docs/verification.md`) | Happy path only. Nothing kills a tab or the SharedWorker mid-write. |
| CI (`.github/workflows/m1-smoke.yml`) | `bench:gate`, `two-tab`, `pnpm test`, `formal:kv` per PR | No nightly or long-running job. No seed sweep. |
| `packages/kv/src/check.ts` | Input validation (key, value and batch limits, db name) | Despite the name, it does not check database integrity. |
| `crates/engine-core` | 26 `#[test]`s (encode/decode, crc, compact, bloom) | No fuzz target or property test for decoding untrusted bytes. |
| Seams | `AsyncFs` is injectable (`HarnessOpenOptions.fs`, `src/db.ts:70`) | The WAL is hard-wired to the global `indexedDB` (`src/idb/wal.ts:106`, `IdBWal.open` at `src/db.ts:307`). `BroadcastChannel`, Web Locks, timers and `crypto.randomUUID` are globals too. A deterministic simulator needs these four behind seams. |
| Collections | Unit tests per feature | No invariant that every index entry matches a row and every row has its index entries. Rows and index entries are written in one `db.update`/`db.batch` (`packages/collections/src/table.ts:285,390`), so such a check is exact. |

## The contract the tests check

Every technique below needs the same oracle. Write it down once, in the product's own terms
(`docs/design.md`, `AGENTS.md`):

- **Prefix consistency.** "Every read sees the state after one prefix of the log." Each `get`,
  `range` and whole `view` must equal `fold(log[1..p])` for some `p`. Within one tab, `p`
  never goes backwards.
- **Read-your-writes at ack.** After a write's ack with seq `s`, that tab's later reads use
  `p ≥ s`.
- **`sync()` is a real-time barrier.** After `sync()` resolves, `p ≥` every seq acked anywhere
  before `sync()` was called.
- **View stability.** All reads in one `view` callback use the same `p`.
- **Crash strength, two levels.** After a tab or SharedWorker *process kill*, every acked write
  survives. `docs/design.md` says an IndexedDB commit "survives a tab crash", and
  [Chrome says](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/)
  relaxed commits fire `complete` once the data reaches the OS buffer. After a simulated
  *power loss*, persistence is waived (`AGENTS.md`: "consistency should be guaranteed,
  persistence not"), but the reopened database must still equal `fold(log[1..p])` for some
  `p`, and it must open.
- **Errors are not answers.** Corrupt bytes surface as `CorruptDatabaseError`, never as a wrong
  value or a silently missing key.

The seq makes the multi-tab check cheap. A general linearizability checker like
[Porcupine](https://github.com/anishathalye/porcupine) searches for some valid order and can
blow up ("state space explosion", per its README). Here the order is recorded: each ack
carries its seq (`changes.ts` emits `{kind: "append", seq}`). If every put writes a unique
value, a read maps back to the seq that wrote it, and the checker only has to find the smallest
`p` consistent with the read. This is the same idea that makes
[Elle](https://github.com/jepsen-io/elle)'s list-append workload efficient: "Elle can infer a
complete prefix of the Adya version order for a key based on a single read." Porcupine and Elle
are the fallback if a future API hides seqs.

## Techniques, ranked by bug-catching value per effort

### 1. Oracle model + stateful property testing (fast-check)

**What mature engines do.** RocksDB's `db_stress` keeps an in-memory copy of expected state.
Each thread checks it, and "after each restart, all the data is verified"
([Stress test wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)). FoundationDB's
cycle workload keeps an invariant (a ring of keys) that any isolation bug breaks
([testing](https://apple.github.io/foundationdb/testing.html)).

**Tooling.** fast-check's `fc.commands` generates command sequences, each command has
`check(model)` and `run(model, real)`, and `fc.asyncModelRun` runs async systems. It "can
efficiently shrink failing scenarios", and a failure replays from `{seed, path}` plus
`replayPath` ([docs](https://fast-check.dev/docs/advanced/model-based-testing/)).
`fc.scheduledModelRun` with `fc.scheduler` decides when each wrapped promise resolves, which is
how fast-check targets races. `scheduler.report()` lists the interleaving that failed
([race conditions](https://fast-check.dev/docs/advanced/race-conditions/)). fast-check is
already a dependency of the statechart skill (`.agents/skills/statechart/scripts/package.json`,
v4.5.3), not of the packages.

**Mapping.** The real system is N `Db` handles from `openHarnessDb` sharing one `MemoryFs`,
one in-process `EngineHost` and one `fake-indexeddb` factory. The model is the global log plus
each handle's `p`. Commands:

| Command | Catches bugs in |
|---|---|
| `put`, `del`, `batch`, `update(keys, body)` on handle *i* | WAL append, `appendAfter` catch-up, memtable apply, gapless seq (`idb/wal.ts`, `db.ts write/landed`) |
| `get`, `range(lo, hi)`, `view(fn)` with several reads | `pointGet` order, merge heap, `RunLevel`, tombstones, pin copy-on-write (`store/read.ts`, `memtable.ts`, `view.ts`) |
| `sync`, deliver or drop a broadcast | `catchUp`, generation install, the 8-retry loop (`db.ts`) |
| `ingest`, `compact` (forced), small `maxWalBytes` | `ingestAll` step order, `advanceTo`, `planCompaction`, the `bottom` tombstone drop, install checks (`host/ingest.ts`, `host/compact.ts`, `store/levels.ts`) |
| `close`, `reopen` handle *i* | WAL replay, `recordedGeneration`, manifest load |
| `checkDatabase` (technique 2) | Every on-disk invariant, after every step or every k steps |

Generators must make collisions likely: draw keys from a small alphabet (8 to 64 keys, shared
prefixes so blocks share a prefix), mix empty and 8 KiB keys and 0-byte to 64 KiB values, and
bias toward deletes so tombstones meet compaction. Shrink-friendly generators matter more than
volume.

**Effort.** Low to medium. Everything needed runs in Node today.

### 2. On-disk invariant checker (`integrity_check`)

**What mature engines do.** SQLite runs `PRAGMA integrity_check` after every injected I/O
error ([§3.2](https://sqlite.org/testing.html)), keeps 6,754 `assert()`s in the core, and runs
the suite three times with `ALWAYS()`/`NEVER()` defined three ways ([§8.1](https://sqlite.org/testing.html)).
LevelDB's `paranoid_checks` "will do aggressive checking of the data it is processing and will
stop early if it detects any errors"
([options.h](https://raw.githubusercontent.com/google/leveldb/main/include/leveldb/options.h)).
TigerBeetle keeps assertions on in production, and its storage checker verifies that caught-up
replicas' data files are byte-identical
([VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md)).
FoundationDB samples extra validation in simulation with `EXPENSIVE_VALIDATION`
([Buggify.h](https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h)).

**Mapping.** A `checkDatabase(fs, wal)` in `packages/kv/src/testing.ts` (test-only export)
asserts:

- `meta.generation` names a manifest that exists and decodes with a valid CRC.
- Every run that manifest lists exists, has a valid footer, magic, version and CRC, and decodes
  in full (`decode_sst`).
- Entries in each run are strictly increasing by key, and the index's first and last keys match
  the blocks.
- Every L0 run's seqs lie in its `<first>-<last>` name. Runs in L1 and below are pairwise
  disjoint and sorted by smallest key, as the manifest order promises.
- The newest seq in any run is ≤ `meta.ingestedThrough`. WAL keys are exactly
  `(ingestedThrough, head]` with no gaps.
- No tombstone at or below `tombstoneSeq` hides a value below it in a deeper level.
- Codec matches `codecForLevel`.
- Orphans (files no live manifest lists) are reported as a count, not as an error. They are
  allowed today (`docs/design.md`, "Files that no manifest lists are never deleted on startup"),
  so the test should check the count stays bounded.
- For collections, a `checkCollections(db)` that verifies the index-to-row bijection.

Also add cheap `assert`-style invariant checks inside `Memtable` (sorted chunks, `appliedThrough`
contiguous) behind a test flag. Doing so is FoundationDB's `EXPENSIVE_VALIDATION` pattern.

**Effort.** Low. It is mostly decoders that already exist.

### 3. Fault-injecting storage and crash-state enumeration

**What the research says.** ALICE showed that "the correctness of these protocols is highly
dependent on subtle behaviors of the underlying file system", and found 60 vulnerabilities in 11
widely-used systems ([OSDI'14 abstract](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai)).
Its method records the system-call trace of a workload, turns it into logical operations, uses
an "Abstract Persistence Model" to generate every crash state the model allows, and runs a
user-written checker on each one (paper §3). 7 of 11 applications had trouble recovering when
ordering was not kept (paper §1). CrashMonkey/ACE found that "most reported bugs can be
reproduced using small workloads of three or fewer file-system operations", and that crashes
after persistence points are what matter
([OSDI'18](https://www.usenix.org/conference/osdi18/presentation/mohan)).

**What mature engines do.** SQLite's TH3 crash test snapshots an in-memory VFS at a chosen I/O
count, reverts to it, applies random power-loss damage, and checks that the database is
well-formed and the transaction atomic ([§3.3](https://sqlite.org/testing.html)). Its TCL
version kills a child process mid-write while a VFS reorders and corrupts unsynced writes.
RocksDB's whitebox crash test places crash points before and after file-system operations,
because "only file system state matters for recovery"
([wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)). `FaultInjectionTestFS` tracks
the position at the last sync, can `DropUnsyncedFileData()` and
`DeleteFilesCreatedAfterLastDirSync()`, and injects read errors as "a status of IOError(), a
corruption in the contents of scratch, or truncation of slice"
([fault_injection_fs.h](https://github.com/facebook/rocksdb/blob/main/utilities/fault_injection_fs.h)).

**Mapping.** This engine has fewer durable operations than a POSIX engine, which makes
exhaustive enumeration practical:

| Durable op | Store | Atomic unit |
|---|---|---|
| WAL append, `appendAfter`, `advanceIngested`, `raiseGeneration` | IndexedDB `readwrite` transaction | whole transaction |
| `publishL0`, compaction outputs, `publishGeneration` | OPFS `createWritable` → `close` | whole file (swap and move) |
| run and manifest reclaim | OPFS `removeEntry` | one entry |

Build a `FaultFs implements AsyncFs` wrapper over `MemoryFs` and a matching WAL wrapper. Each
records a global numbered trace of durable ops. Then:

- **Crash enumeration (process kill).** For a workload of a few batches plus one ingest and one
  compaction, crash after op *k* for every *k*. Discard in-memory state, reopen from the
  durable state, run `checkDatabase`, and check that the state equals `fold(log[1..p])` with
  `p ≥` the last acked seq. This tests every row of the "Crash behavior" table in
  `docs/design.md` mechanically.
- **Power-loss enumeration.** Give each store its own "durable through op j" cursor, and enumerate
  `(j_idb, j_opfs)` pairs, so the two stores may lose different suffixes. Check prefix
  consistency and openability only. This is ALICE's abstract persistence model applied to two
  stores whose relative order the platform does not promise **(inferred)**.
- **Error injection.** Make the *k*-th op fail: `create` or `write` throws (`QuotaExceededError`),
  `close` rejects (the spec allows `AbortError` on close,
  [fs.spec](https://fs.spec.whatwg.org/)), `remove` fails, a read returns `undefined` (file
  gone), or an IndexedDB transaction aborts. This is SQLite's I/O-error loop: fail at N, raise
  N until the operation completes, once with a one-shot fault and once with a persistent one
  ([§3.1–3.2](https://sqlite.org/testing.html)). Afterwards, every acked write must still read
  back and `checkDatabase` must pass.
- **Compound faults.** An error during recovery (reopen) after a crash (SQLite §3.4).

**Effort.** Medium. The WAL seam is the main product change: a narrow interface over the
transactions `IdBWal` runs, or an injectable `IDBFactory` (fake-indexeddb exports one) plus a
wrapper that can drop the last committed transactions.

### 4. Deterministic simulation (FoundationDB, TigerBeetle, Antithesis)

**What mature engines do.** FoundationDB runs "a deterministic simulation of an entire
FoundationDB cluster within a single-threaded process" with simulated machines, disks and network,
and runs tens of thousands of simulations nightly. "It seems unlikely that we would have been
able to build FoundationDB without this technology"
([testing](https://apple.github.io/foundationdb/testing.html)). Its `buggify()` sites are
enabled per run with probability 0.25 the first time each site is reached, and then fire with
probability 0.25. They pull rare code paths into every run
([Buggify.h](https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h)).
TigerBeetle's VOPR stubs clock, network and disk, is "deterministic based on a seed number and
the Git commit", and claims "one minute of VOPR time is equivalent to days of real-world
testing" ([VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md)).
Its simulated storage corrupts sectors on read and write, misdirects writes, and on crash
"corrupt[s] the target sectors of any in-progress writes"
([storage.zig](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/testing/storage.zig)).
Antithesis runs unmodified containers in a deterministic hypervisor with faults such as
"network partitions or node kills", guided toward unexplored states
([docs](https://antithesis.com/docs/introduction/how_antithesis_works/)). Will Wilson's Strange
Loop 2014 talk on FoundationDB's simulator is the usual introduction
([video](https://www.youtube.com/watch?v=4fFDFbi3toc)) **(unverified: not watched for this
note)**.

**Mapping.** A browser engine in Node is already single-threaded. What breaks determinism is
the set of globals: `BroadcastChannel` delivery, Web Locks grant order, timers, IndexedDB
callback order, `crypto.randomUUID`. Put each behind a seam (`Env` with `bus`, `locks`,
`timers`, `random`, `wal`, `fs`) driven by one seeded PRNG. The simulator then owns:

- **Message faults.** Delay, reorder across senders, or drop any `BroadcastChannel` message.
  The design claims to tolerate lost and late messages (`docs/design.md`, platform
  assumptions). The simulator turns that claim into a check.
- **Scheduling.** Interleave tabs' IndexedDB transactions, the host's ingest and compaction
  steps, and reclaim. "A run file can disappear between the manifest read and the run read" is
  a real interleaving. The simulator should force it, and force it nine times in a row to
  check that `GENERATION_GONE` (`db.ts:561,595`) is not raised on a healthy database.
- **Buggify points.** In test builds, `buggify()` can shrink `TARGET_RUN_BYTES` and block size,
  set `maxWalBytes` to a few bytes, force `bottom` plans, fail wasm load so the TypeScript
  fallbacks run, and run two `EngineHost`s for one database (the case the
  `opfs-lsm-ingest/<name>` Web Lock exists for).
- **Crash and power loss** from technique 3, at random points instead of enumerated ones.

Technique 1 already captures much of this at lower cost, because `fc.scheduler` controls promise
order. Build the full simulator when the fast-check suite stops finding bugs, or when the
remaining bugs need message loss and multi-host races to show up.

**Effort.** Medium to high, mostly the seams. Antithesis would need the engine in a container
with a browser or Node workload. Its value here is low until the cheap tiers are exhausted.

### 5. Multi-tab history checking

Use the seq-based exact checker described under [The contract](#the-contract-the-tests-check).
It runs over histories from the fast-check suite (technique 1), the simulator (4), and the
real-Chrome drive (6). On real Chrome, each tab logs `(tab, op, key, value, seq?, start,
end)` with `performance.timeOrigin + now()`, and the harness merges the logs. Porcupine (Go)
and Elle (Clojure) remain available if the API ever hides seqs. Porcupine reports being "about
1,000x to 10,000x faster" than Knossos on Jepsen data
([README](https://github.com/anishathalye/porcupine)).

### 6. Real-Chrome kill tests

MemoryFs proves the protocol. Only Chrome proves the platform assumptions in
`docs/design.md`: that `close()` swaps the file atomically, that an IndexedDB commit survives a
renderer crash, that Web Locks release on termination, and that a SharedWorker restarts cleanly.

Chrome DevTools Protocol commands, from
[browser_protocol.json](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json):

| Command | Experimental | Description |
|---|---|---|
| `Page.crash` | yes | "Crashes renderer on the IO thread, generates minidumps." |
| `Target.closeTarget` | no | "Closes the target." Works on a SharedWorker target too (verified on Chrome 156, see [Phase 5 results](#phase-5-results-2026-11-08)). |
| `Browser.crash` | yes | "Crashes browser on the main thread." |
| `Storage.overrideQuotaForOrigin` | yes | Shrinks quota, so OPFS writes hit `QuotaExceededError`. On Chrome 156 IndexedDB writes ignore it (see [Phase 5 results](#phase-5-results-2026-11-08)). |

Plus `kill -9` of the renderer or browser PID from the harness, which RocksDB's blackbox crash
test does with its own process ([wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)).

Recipe (an extension of `packages/kv/scripts/two-tab.ts`, which already speaks raw CDP over
WebSocket): open 2 to 3 tabs on one profile, run a random write workload with a small
`maxWalBytes` so ingest and compaction run constantly, kill something at a random time, relaunch
on the same profile, run `checkDatabase` in the page, and compare against the acked log the
harness recorded. Repeat for many seeds. A process kill does not lose power, so this checks the
stronger "acked survives" level.

Power loss cannot be produced in CI. A VM snapshot-restore or a "drop the page cache" trick could
approximate it **(unverified)**. Technique 3's two-store model is the practical substitute.

### 7. Fuzzing the decoders

SQLite requires that corrupt database files produce `SQLITE_CORRUPT` "without buffer overflows
or NULL dereferences". Its `dbsqlfuzz` mutates SQL and the database file together, and
`fuzzcheck` replays a few thousand saved interesting cases on every `make test`
([§4](https://sqlite.org/testing.html)).

Targets here:

| Target | Language | Tool |
|---|---|---|
| `decode_sst`, `scan_block_contains`, LZ4 unpack, compaction merge over decoded inputs | Rust (`crates/engine-core/src/sst.rs`, `compact.rs`) | `cargo fuzz` (libFuzzer) natively on `engine-core`, "the recommended tool for fuzz testing Rust code" ([book](https://rust-fuzz.github.io/book/cargo-fuzz.html)) |
| `SstReader` (footer, index, block walk, offset table), `lz4.ts`, manifest decode (`store/generation.ts`), WAL row decode (`idb/wal.ts`) | TypeScript | fast-check `fc.uint8Array` plus a mutator over valid encodings (cheap, no coverage guidance), then Jazzer.js for coverage guidance |
| TS encoder against Rust encoder | both | Differential: identical bytes for identical input. `docs/design.md` says the two "cut blocks in the same places" |

Jazzer.js is "a coverage-guided, in-process fuzzer for the Node.js platform" built on libFuzzer,
with a Jest integration (`it.fuzz`) ([README](https://github.com/CodeIntelligenceTesting/jazzer.js)).
Its latest release is v4.0.0 (2026-04-15), and the repo is not archived (GitHub API, checked
2026-11-06). It integrates with Jest, not vitest, so it would run as a separate script.

Property to assert: for any mutated input, the decoder returns the original entries, or throws
`CorruptDatabaseError`, within a time bound. Save crashing inputs as a regression corpus in the
repo, as `fuzzcheck` does.

**Note on the read path.** Tabs do not check the SST CRC on read. Only the SharedWorker does,
while it decodes compaction inputs (`docs/design.md`, "Reading a run"). A bit flip in a raw L0
or L1 data block can therefore return a wrong value with no error until that run is compacted.
The fuzz suite will show this as "wrong answer, no throw". Whether to accept it is a design
call. RocksDB- and LevelDB-style per-block checksums (`verify_checksums`: "all data read from
underlying storage will be verified against corresponding checksums",
[options.h](https://raw.githubusercontent.com/google/leveldb/main/include/leveldb/options.h))
would cost a CRC per block read instead of per file open **(inferred)**.

### 8. Measuring the suite: differential modes, mutation testing, coverage

- **Differential modes.** SQLite runs the suite with optimizations on and off and requires
  matching output ([§9](https://sqlite.org/testing.html)). Here: run the model-based suite once
  with wasm and once with the TypeScript fallbacks forced, once with LZ4 at every level and once
  raw, and once with block stride or size shrunk. Every mode must match the oracle.
- **Mutation testing.** SQLite turns branches into jumps or no-ops and requires the suite to
  notice ([§7.6](https://sqlite.org/testing.html)). StrykerJS does this for TypeScript and has
  a Vitest runner ([intro](https://stryker-mutator.io/docs/stryker-js/introduction/)). Point it at
  `store/read.ts`, `store/fold.ts`, `store/memtable.ts`, `store/levels.ts`, `host/ingest.ts`,
  `host/compact.ts` and `idb/wal.ts`, with the model-based suite as the test command. A
  surviving mutant in a merge or ingest path marks a property the suite does not check.
  `cargo-mutants` would do the same for `engine-core` **(unverified: not read for this note)**.
- **Coverage.** Branch coverage of the fault paths (`catch`, `abort`, the retry loops) is the
  number to watch. SQLite calls its coverage run "a test of the test - a meta-test"
  ([§7.5](https://sqlite.org/testing.html)).

### 9. Soak and continuous runs

RocksDB's crash test "keeps running for several hours" per database, across normal and
sanitizer builds ([wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)). SQLite runs a
pre-release soak of about 248.5 million TH3 tests ([§1.1](https://sqlite.org/testing.html)).
FoundationDB runs tens of thousands of simulations each night
([testing](https://apple.github.io/foundationdb/testing.html)).

Here:

- **Per PR.** A fixed set of seeds (fast, about one minute) plus every saved regression seed.
- **Nightly.** Random seeds for an hour across the fast-check, crash-enumeration and simulator
  suites, plus 30 minutes of the real-Chrome kill loop. Print each failing seed and replay path
  in the log, and commit it as a regression case.
- **Rule from SQLite §5.** A bug is not fixed until a test that reproduces it is in the suite.
  With seeds, that test is one line.

### 10. Recovery semantics: corruption is not a crash

Protocol-Aware Recovery shows that the obvious reactions to a storage fault are unsafe. Treating
corruption as a crash makes the node unavailable. Truncating at the corrupt entry causes "silent
data loss". Deleting and rebuilding has the same problem
([FAST'18 §2.3](https://www.usenix.org/conference/fast18/presentation/alagappan)). Storage faults
show up as block errors or silent corruption, including from "lost and misdirected writes"
(paper §2.1). A single-node browser engine cannot repair from a replica. Its tests should
still pin down which reaction it chooses:

- A missing or corrupt run throws `CorruptDatabaseError`. It must never be skipped silently.
- A corrupt newest manifest file that IndexedDB does not record yet is ignored.
- The engine must not "fix" a gap by deleting data.

## Proposed suite layout and roadmap

```text
packages/kv/
  src/testing.ts                 + checkDatabase, FaultFs, env seams (test-only exports)
  tests/sim/
    oracle.ts                    log + fold + prefix checker (contract above)
    history.ts                   recorded ops, seq-exact consistency check
    fault-fs.ts                  AsyncFs wrapper: trace, crash-at, error-at, drop-after
    fault-wal.ts                 WAL wrapper: trace, crash-at, drop committed suffix
    commands.ts                  fc.commands for put/del/batch/update/get/range/view/sync/
                                 ingest/compact/close/reopen/check
    model.test.ts                fc.asyncModelRun, then fc.scheduledModelRun (multi-handle)
    crash-enum.test.ts           crash after every durable op k; two-store power-loss pairs
    io-error.test.ts             fail op N for N = 1.. until success; one-shot and persistent
    regressions.test.ts          saved seeds and replay paths
  fuzz/                          TS decoder properties and Jazzer.js targets + corpus
  scripts/kill-chrome.ts         CDP crash/kill loop on top of two-tab.ts
crates/engine-core/fuzz/         cargo fuzz targets: decode_sst, scan_block_contains, compact
packages/collections/tests/sim/  same harness with table/index commands + checkCollections
.github/workflows/nightly.yml    seed sweep, crash enumeration at larger bounds, Chrome kill loop
```

| Phase | Deliverable | Finds bugs in | Effort |
|---|---|---|---|
| 1 | `oracle.ts`, `checkDatabase`, single-handle `model.test.ts` | merge order, tombstones, compaction, memtable `advanceTo`, view | 1 to 2 days |
| 2 | Multi-handle commands, `fc.scheduler`, history check | cross-tab catch-up, generation install, retry loop, `update` | 1 to 2 days |
| 3 | `FaultFs`, WAL seam, `crash-enum`, `io-error` | the "Crash behavior" table, reclaim, orphans, error paths | 2 to 4 days |
| 4 | Fuzz targets (Rust + TS) and corpus | decoders, malformed files, wasm and TS divergence | 1 to 2 days |
| 5 | Chrome kill loop in nightly CI (done: `scripts/kill-chrome.ts`, `.github/workflows/nightly.yml`) | platform assumptions, SharedWorker restart, Web Lock release | 2 to 3 days |
| 6 | Env seams + deterministic simulator with buggify; Stryker; differential modes | message loss, multi-host races, untested branches | ongoing |

The effort column is my estimate **(inferred)**.

### Phase 5 results (2026-11-08)

`packages/kv/scripts/kill-chrome.ts` is the loop of technique 6. `docs/verification.md`, "Kill real
Chrome", says how it works and what a pass means. It ran locally on Chrome 156.0.8078.80 on
macOS, about 46 minutes and 600 iterations in four runs, with the probes passing in each:

| Run | Kinds | Iterations | Failures |
| --- | --- | --- | --- |
| seed 424242, 20 min | all six, 50 each | 300 | 3: one checker false positive (a `.crswap` in `m/`, fixed), two open (below) |
| seed 31337 | all six | 40, then stopped | 0, then Chrome failed every `indexedDB.open` on that profile |
| seed 5150, 10 min | kill-browser, browser-crash, page-crash | 154 | 1: the relaunched Chrome died at once (harness, now retried) |
| seed 8086, 10 min | all six, 23 each | 138 | 0 |

Verified on that Chrome:

- An acked IndexedDB commit survives `Page.crash`, `kill -9` of a renderer or of the browser,
  and `Browser.crash`, unless Chrome then drops its IndexedDB store (below). Apart from the two
  open cases below, no iteration lost an ack, and every recovered state was the fold of the log
  through the recovered head.
- A tab or browser killed mid-`createWritable` leaves the target file as it was.
- Web Locks of a crashed tab (reclaim, run and ingest locks) and of a SharedWorker closed by
  `Target.closeTarget` (ingest and compaction locks) are free at once.
- `Target.closeTarget` accepts a SharedWorker target id and closes it. No
  `Target.targetDestroyed` arrives for it; it leaves `Target.getTargets`. A tab that opens the
  database next gets a new SharedWorker that ingests, as long as DevTools is not attached to
  the closed one. While a DevTools session was attached, the next tab got no working worker.
- After `kill -9` of the browser mid-`createWritable`, the swap file stays in OPFS as
  `<name>.crswap`, listed by `entries()`, across relaunches. Chrome does not clean it up. In a
  level directory the engine's reclaim removes it as an orphan. In `m/` nothing did: the
  engine skipped the name, and each browser crash during a manifest write leaked one file.
  Fixed: manifest reclaim removes a swap file once the recorded generation reaches its
  number. `checkDatabase` lists them as `swapFiles`.
- `Storage.overrideQuotaForOrigin` works only on a page session (the browser session answers
  "Internal error"), and only for OPFS writes. IndexedDB commits and
  `navigator.storage.estimate()` ignore it. Under it, ingest fails, and the tab's `ingest()`
  rejected with a plain `Error` (the `QuotaExceededError` class does not cross the port).
  Fixed: it rejects with `StorageFullError`, code `quota`. The database stays clean, and
  ingest works again once the quota is restored.
- After `kill -9` of the browser or `Browser.crash`, Chrome sometimes damages its own
  IndexedDB store (a LevelDB `CURRENT` naming a missing `MANIFEST`, and a
  `corruption_info.json`). The next launch fails `indexedDB.open` with `UnknownError`, and
  Chrome then deletes every IndexedDB database of the origin, or keeps failing every open.
  OPFS is untouched. 13 of the 149 browser kills of the last two runs, on macOS. The engine
  treats it as an IndexedDB power loss and recovers the newest intact manifest, so this is a persistence loss
  (the WAL tail), not corruption. `openDb` rejected with the raw `UnknownError`. Fixed: it
  rejects with `StorageUnavailableError`, with the `UnknownError` as `cause`.

Open: in the first 20-minute run, two iterations right after such a wipe failed the prefix
check (seed 424242, iterations 59 and 239). In one, an ingested key was gone; in the other,
seqs restarted at 1 and the old manifests were gone. That harness then SIGKILLed Chrome's
helpers, the storage service among them, the moment the browser process exited, even after a
normal close. Since it waits for them to exit, 292 iterations (149 of them browser kills, with 13
wipes) found no loss, and a Node test that deletes the WAL between sessions or under an
open handle recovers a prefix. The cause, Chrome or the engine, is not known.

Still unverified: power loss (fsync of the swap file before the move, the order in which
IndexedDB and OPFS reach disk), IndexedDB under quota, IndexedDB key generator rollback on a
commit cut by a kill beyond what `checkDatabase`'s gap check sees, Linux and other browsers.
The nightly workflow runs the loop on Linux.

Extend `formal:kv` in parallel with its own "Not covered yet" list (crash between
`publishGeneration` and `advanceIngested`, reclaim against a view pin, BroadcastChannel against
a generation bump). The exhaustive models and the random suites complement each other. The
models prove small domains completely, and the random suites cover large domains partly.

## Browser durability facts and their limits

| Fact | Source | Limit |
|---|---|---|
| `createWritable()` writes go to a temporary file. "Any changes made through stream won't be reflected in the file entry … until the stream has been closed." | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | — |
| On close, "It is expected that this atomically updates the contents of the file on disk". "User agents try to ensure that no partial writes happen." | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | "Expected" and "try" are not a guarantee. |
| `close()` can reject with `AbortError` (safe-browsing or malware checks), and then the file is not updated. | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | Test the error path. |
| Chromium writes to a swap file and, on `Close()`, moves it onto the target. "In most filesystems, this move operation is atomic." If the renderer's pipe is severed before `Close()` or `Abort()`, "the transaction is aborted". | [file_system_access_file_writer_impl.h](https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_file_writer_impl.h) | I found no explicit flush or fsync in `file_system_access_file_writer_impl.cc` (main, 2026-11-06). Whether data is fsynced before the move is **unverified**. Do not assume an OPFS publish is durable against power loss. |
| A tab killed mid-`createWritable` leaves the target untouched. | Same header (mojo disconnect aborts) | Swap-file cleanup after a *browser* crash is **unverified**. |
| `FileSystemSyncAccessHandle.flush()` steps: "Attempt to transfer all cached modifications … to the file system's underlying storage device". It "can be a no-op on some file systems". `close()` "does not guarantee that all file modifications will be immediately reflected in the underlying storage device". | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | This engine does not use sync access handles. The fact matters only if the WAL moves to OPFS. |
| A sync access handle takes an exclusive lock on the file. A second one fails with `NoModificationAllowedError`. | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | — |
| IndexedDB durability: `relaxed` commits "as soon as all outstanding changes have been written to the operating system, without subsequent verification". With `strict`, implementations typically flush OS buffers before `complete`. | [IndexedDB spec §2.7](https://w3c.github.io/IndexedDB/) | — |
| Chrome 121 made `relaxed` the default. `complete` fires "after changes make it to the OS buffer", which "is typically flushed every couple seconds". A power failure can lose the change. "strict does not ensure that changes are actually written immediately to disk." | [Chrome blog](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/) | The engine uses the default, so acked writes can be lost on power loss. This matches `AGENTS.md`. |
| "Aborting a transaction rolls back any increases to the key generator." | [IndexedDB spec §2.11](https://w3c.github.io/IndexedDB/) | The gapless-seq design depends on this. Test it on Chrome, not only on fake-indexeddb. |
| No spec text found that orders an IndexedDB commit relative to an OPFS file move. | — | Treat them as independently durable **(inferred)**. |
| Web Locks: "When an agent terminates, terminate remaining locks and requests with the agent." The spec notes worker termination is "vaguely defined". `steal` leaves the old holder running "without guarantees that it is the sole context". Locks are per storage bucket. | [Web Locks spec](https://w3c.github.io/web-locks/) | Verified on Chrome 156: released at once after a tab crash and after `Target.closeTarget` on the SharedWorker (`kill-chrome` probes). |
| SharedWorkers are identified by script URL and name. User agents "may invoke the terminate a worker algorithm when a worker stops being actively needed", which aborts the running script. | [HTML §10](https://html.spec.whatwg.org/multipage/workers.html) | The host can die between any two awaits of an ingest or compaction. The crash enumeration covers this. |
| SQLite's own OPFS VFSs rely on exclusive sync access handles. A second tab "will hit a locking error". WAL mode needs `locking_mode=exclusive`. The docs make no durability or crash-recovery claim, and say databases can vanish through browser cleanup. | [sqlite.org/wasm persistence](https://sqlite.org/wasm/doc/trunk/persistence.md) | Prior art avoids multi-writer OPFS. This engine routes writes through IndexedDB and one SharedWorker instead. |
| wa-sqlite marks which VFSs support multiple connections and relaxed durability. Its OPFS multi-connection VFSs use a "retry hack" that can "expose possible race condition failures". | [wa-sqlite examples](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples) | — |

## Risks to target first

These are hypotheses from reading `docs/design.md` and `host/ingest.ts` against the facts above.
None is confirmed. Each is a concrete first test case for phases 3 and 5.

1. **Ingest under power loss (inferred).** Step 5 deletes WAL records through `last` and sets
   `ingestedThrough` and `generation` in IndexedDB. Steps 3 and 4 published the L0 run and
   manifest through OPFS. If the IndexedDB commit reaches disk and the OPFS move does not, the
   reopened database has lost seqs `first..last` while keeping later WAL seqs. That state is
   not a prefix, so it breaks consistency, not only persistence. Alternatively the recorded
   manifest is missing and the database will not open (`GENERATION_GONE`).
2. **Compaction and reclaim under power loss (inferred).** Install raises `generation` in
   IndexedDB and then removes the input runs and old manifests from OPFS. If the removals are
   durable and the raise is not, the recorded generation lists deleted runs.
3. **Duplicate run listing.** `docs/design.md` notes that after a crash between the manifest
   write and the IndexedDB update, a later manifest can list the same L0 path twice. The design
   says reads stay correct. Compaction over a duplicated input, and reclaim of a path listed
   twice, should be exercised explicitly.
4. **False corruption under churn.** `catchUp` retries 8 times and then throws
   `CorruptDatabaseError(GENERATION_GONE)`. A simulator that compacts on every step can check
   that a healthy database never reaches that error.
5. **Silent wrong reads.** Tabs skip the SST CRC (technique 7). Decide whether that is
   acceptable, and test it either way.
6. **Unbounded orphans.** Orphan files are never collected on startup. A soak should check
   that they stay bounded.

## Not verified

- The full text of SQLite's journal-test VFS, TH3 internals, and dbsqlfuzz are proprietary or
  were not read beyond `testing.html`.
- FoundationDB's `testing.html` does not describe seeds or buggify. The buggify details come
  from `flow/include/flow/Buggify.h`. The Will Wilson talk was not watched.
- The ALICE per-application vulnerability list (LevelDB, SQLite counts) was not extracted. Only
  the abstract, §1 to §3 and the method were read.
- Whether Chrome fsyncs an OPFS swap file before the move, and how it orders IndexedDB and
  OPFS writes on disk. (It does not clean up `.crswap` files after a browser crash: see
  [Phase 5 results](#phase-5-results-2026-11-08).)
- The spec behavior of IndexedDB transactions in flight when the context is destroyed (section
  not located). `Target.closeTarget` on a SharedWorker is verified: see
  [Phase 5 results](#phase-5-results-2026-11-08).
- `cargo-mutants` and Knossos were not read. Porcupine and Elle details come from their READMEs.
- Jazzer.js FuzzedDataProvider and bug detectors are documented in its `docs/`, which I did not
  read.

## Sources

- SQLite, How SQLite Is Tested: https://sqlite.org/testing.html
- FoundationDB, Simulation and Testing: https://apple.github.io/foundationdb/testing.html
- FoundationDB, `flow/include/flow/Buggify.h`: https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h
- TigerBeetle, VOPR: https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md
- TigerBeetle, simulated storage: https://github.com/tigerbeetle/tigerbeetle/blob/main/src/testing/storage.zig
- TigerBeetle, Safety: https://docs.tigerbeetle.com/concepts/safety/
- Antithesis, How Antithesis works: https://antithesis.com/docs/introduction/how_antithesis_works/
- RocksDB wiki, Stress test: https://github.com/facebook/rocksdb/wiki/Stress-test
- RocksDB, `utilities/fault_injection_fs.h`: https://github.com/facebook/rocksdb/blob/main/utilities/fault_injection_fs.h
- LevelDB, `include/leveldb/options.h`: https://github.com/google/leveldb/blob/main/include/leveldb/options.h
- fast-check, Model-based testing: https://fast-check.dev/docs/advanced/model-based-testing/
- fast-check, Race conditions: https://fast-check.dev/docs/advanced/race-conditions/
- Porcupine: https://github.com/anishathalye/porcupine
- Elle: https://github.com/jepsen-io/elle
- Pillai et al., All File Systems Are Not Created Equal (OSDI'14): https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai
- Mohan et al., Finding Crash-Consistency Bugs with Bounded Black-Box Crash Testing (OSDI'18): https://www.usenix.org/conference/osdi18/presentation/mohan
- Alagappan et al., Protocol-Aware Recovery for Consensus-Based Storage (FAST'18): https://www.usenix.org/conference/fast18/presentation/alagappan
- WHATWG File System: https://fs.spec.whatwg.org/
- W3C IndexedDB: https://w3c.github.io/IndexedDB/
- W3C Web Locks: https://w3c.github.io/web-locks/
- WHATWG HTML, Workers: https://html.spec.whatwg.org/multipage/workers.html
- Chrome, A change to the default durability mode in IndexedDB: https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/
- Chromium, `file_system_access_file_writer_impl.h`: https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_file_writer_impl.h
- Chrome DevTools Protocol, `browser_protocol.json`: https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json
- SQLite Wasm, Persistent storage options: https://sqlite.org/wasm/doc/trunk/persistence.md
- wa-sqlite examples: https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples
- Jazzer.js: https://github.com/CodeIntelligenceTesting/jazzer.js
- StrykerJS: https://stryker-mutator.io/docs/stryker-js/introduction/
- Rust Fuzz Book, cargo-fuzz: https://rust-fuzz.github.io/book/cargo-fuzz.html
