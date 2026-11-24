# A test suite that keeps corruption out of `@opfs-lsm/kv`

Status: shipped, except technique 4 (a deterministic simulator) and the StrykerJS and coverage parts of technique 8. [docs/verification.md](../verification.md) describes the suite and what a pass looks like.

Date: researched 2026-11-06. Kill-loop results 2026-11-08, Chrome 156.0.8078.80 on macOS. Checked against the code on 2026-11-24.

## Question

How do we build a test suite that brings the risk of corruption bugs as close to zero as we can? The note ranked ten techniques from SQLite, FoundationDB, TigerBeetle and RocksDB by bugs caught per unit of effort.

## Decisions (2026-11-06)

All four still hold.

1. **Crash contract.** Losing recent acked writes on crash or power loss is acceptable; it is outside the engine's control. Corruption is not: after any crash the database must open, and its state must be the fold of a prefix of the log. A test that reaches a non-prefix state or an unopenable database has found a bug, not an accepted limit. The note's two risks, an ingest and a compaction install whose stores keep different prefixes after a power loss, are what recovery's rules 1 and 3 now handle (design.md, "Recovery").
2. **SST CRC in tabs stays skipped.** The engine does not defend against tampering, and data in the browser is untrusted anyway. Decoder fuzzing therefore requires no hang, crash or out-of-bounds read on corrupt bytes; a wrong answer from a corrupt SST read in a tab is accepted.
3. **Seams live in the test harness first.** Change production code only when a harness-side approach is not feasible or would make tests flaky. The WAL seam became a wrapper on fake-indexeddb's object store and factory, with no product change.
4. **New dev dependencies are fine.** fast-check and Jazzer.js were added. `cargo fuzz` went with the Rust crate it targeted, and StrykerJS was never added.

## The contract the tests check

`tests/sim/oracle.ts`, `history.ts` and `crash.ts` check these rules. verification.md, "Run the unit tests", lists them all.

- Every `get`, `range` and whole `view` equals `fold(log[1..p])` for some `p`. Within one handle, `p` never goes back.
- After a write's ack with seq `s`, that handle's later reads use `p ≥ s`. After `sync()` resolves, `p` is at or past every seq acked anywhere before the call.
- Crash strength has two levels. After a process kill of a tab or the SharedWorker, every acked write survives. After a power loss, persistence is waived, but the database must open and equal `fold(log[1..p])` for some `p`.
- Corrupt bytes surface as an error, never as a silently missing key. Decision 2 allows a wrong value from a tab's run read.

## Techniques

### 1. Oracle model and stateful property testing (fast-check)

Random command lists run against the engine and an in-memory log. RocksDB's `db_stress` keeps an expected state and verifies it "after each restart" ([Stress test wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)). fast-check shrinks a failing command list and replays it from `{seed, path}` ([model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)). It lives in `tests/sim/commands.ts`, `oracle.ts` and `model.test.ts` for one handle, and `multi.ts` with `multi-handle.test.ts` for three. `fc.scheduledModelRun` was not used, because it deadlocks a command that waits for its op. The harness parks its own await points as `fc.scheduler` tasks instead.

### 2. On-disk invariant checker (`integrity_check`)

A walk of the WAL, the recorded manifest and its runs after each test. SQLite runs `PRAGMA integrity_check` after every injected I/O error ([§3.2](https://sqlite.org/testing.html)). It is `tests/sim/check-database.ts`, and the sim suites and `kill-chrome` call it.

### 3. Fault-injecting storage and crash-state enumeration

ALICE checked every crash state an abstract persistence model allows and found 60 vulnerabilities in 11 widely-used systems ([OSDI'14](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai)). CrashMonkey found that "most reported bugs can be reproduced using small workloads of three or fewer file-system operations" ([OSDI'18](https://www.usenix.org/conference/osdi18/presentation/mohan)). Here `tests/sim/fault-fs.ts` and `fault-wal.ts` record the durable ops of both stores in one numbered trace. `crash.ts` rebuilds each crash state, and `crash-enum.test.ts` checks a process crash (one cut) and a power loss (each store keeps its own prefix).

**Error injection.** SQLite fails I/O op N, then raises N until the operation completes, once with a one-shot fault and once with a persistent one ([§3.1, §3.2](https://sqlite.org/testing.html)). `tests/sim/io-error.test.ts` does the same over durable sites and read sites.

**Compound faults** (SQLite §3.4). `formal:power-loss` goes two power losses deep, and `power-loss-chrome` loses a recovery a second time. No test injects an I/O error into the recovery after a crash.

### 4. Deterministic simulation (FoundationDB, TigerBeetle, Antithesis)

FoundationDB simulates a whole cluster in one process, and a `buggify()` site is enabled with probability 0.25 the first time a run reaches it, then fires with probability 0.25 ([testing](https://apple.github.io/foundationdb/testing.html), [Buggify.h](https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h)). TigerBeetle's VOPR is "deterministic based on a seed number and the Git commit" ([VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md)). The proposal put BroadcastChannel, Web Locks, timers, randomness and both stores behind one seeded seam. Not built. The note's condition still applies. Build it when the fast-check suites stop finding bugs, or when the remaining bugs need message loss and multi-host races. Meanwhile `multi.ts` drops BroadcastChannel deliveries and orders file calls through `fc.scheduler`. Two `EngineHost`s on one database appear only in example tests such as `tests/ingest-lock.test.ts`.

### 5. Multi-tab history checking

Each ack carries its seq, so a read maps back to the seq that wrote it, and the checker only has to find the smallest `p` that fits. A general linearizability checker such as [Porcupine](https://github.com/anishathalye/porcupine) searches for an order and can hit "state space explosion". [Elle](https://github.com/jepsen-io/elle) uses the same recorded-order idea, and "can infer a complete prefix of the Adya version order for a key based on a single read". `tests/sim/history.ts` is that checker. In real Chrome, `kill-chrome` records acks over a CDP binding and tries every order of the in-flight attempts. Porcupine and Elle stay the fallback if the API ever hides seqs.

### 6. Real-Chrome kill tests

MemoryFs proves the protocol, and only Chrome proves the platform assumptions. `packages/kv/scripts/kill-chrome.ts` (verification.md, "Kill real Chrome") uses `Page.crash`, `Target.closeTarget`, `Browser.crash` and `Storage.overrideQuotaForOrigin` from [browser_protocol.json](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json), plus `kill -9`. The note judged power loss impossible to produce. `packages/kv/scripts/power-loss-chrome.ts` now makes the state where IndexedDB lost its newest commits, by restoring a copy of the IndexedDB directory. A real power cut is still not produced.

### 7. Fuzzing the decoders

SQLite requires that a corrupt file return `SQLITE_CORRUPT` "without buffer overflows or NULL dereferences", and replays saved fuzz cases on every `make test` ([§4](https://sqlite.org/testing.html)). The note proposed `cargo fuzz` on the Rust engine, which no longer exists. The engine is AssemblyScript (`packages/kv/engine`). `packages/kv/fuzz/targets.ts` holds the rules, `fuzz/decoders.test.ts` runs fast-check mutations, `fuzz/jazzer/` runs Jazzer.js targets, and `fuzz/engine-checked.test.ts` runs the engine on a checked twin that throws on any bad memory access. verification.md, "Fuzz the decoders", states the rules.

Tabs do not check the SST CRC on read, so a bit flip in a data block can return a wrong value with no error until compaction reads the run. LevelDB-style per-block checksums ([options.h](https://github.com/google/leveldb/blob/main/include/leveldb/options.h), `verify_checksums`) would cost a CRC per block read instead of per file open (inferred). Decision 2 accepted the wrong answer.

### 8. Measuring the suite: differential modes, mutation testing, coverage

SQLite runs its suite with optimizations on and off, and requires it to notice branches turned into no-ops ([§9, §7.6](https://sqlite.org/testing.html)). There is no TypeScript fallback to force, so `packages/kv/fuzz/differential.test.ts` and `tests/merge-session.test.ts` check wasm against TypeScript reference oracles in `tests/oracle/`. `mutant-canary` plants a committed list of bugs in the engine source and requires the checked suites to catch each one. [StrykerJS](https://stryker-mutator.io/docs/stryker-js/introduction/) over the TypeScript store, host and WAL, and a coverage measure of the fault paths, were not built.

### 9. Soak and continuous runs

RocksDB's crash test "keeps running for several hours" per database ([wiki](https://github.com/facebook/rocksdb/wiki/Stress-test)). SQLite §5 holds that a bug is not fixed until a test that reproduces it is in the suite. Here the nightly workflow runs the `seed-sweep`, `kill-chrome`, `engine-fuzz` and `mutant-canary` jobs (verification.md, "What CI runs"). Saved failures live in `tests/sim/regressions.test.ts` and `fuzz/findings.test.ts`.

### 10. Recovery semantics: corruption is not a crash

Protocol-Aware Recovery shows that treating corruption as a crash makes the node unavailable, and that truncating at the corrupt entry causes "silent data loss" ([FAST'18 §2.3](https://www.usenix.org/conference/fast18/presentation/alagappan)). A browser engine has no replica to repair from, so it refuses. design.md, "Corruption is not a power loss", states the rule, and `tests/sim/corruption.test.ts` and `CorruptRefuse` in `formal:kv` check it.

## Phase 5 results (2026-11-08)

`kill-chrome` ran locally on Chrome 156.0.8078.80 on macOS, about 46 minutes and 600 iterations in four runs, with the probes passing in each. verification.md, "Kill real Chrome", records what the loop showed and the fixes it led to.

| Run | Kinds | Iterations | Failures |
| --- | --- | --- | --- |
| seed 424242, 20 min | all six, 50 each | 300 | 3: one checker false positive (a `.crswap` in `m/`, fixed), two open (below) |
| seed 31337 | all six | 40, then stopped | 0, then Chrome failed every `indexedDB.open` on that profile |
| seed 5150, 10 min | kill-browser, browser-crash, page-crash | 154 | 1: the relaunched Chrome died at once (harness, now retried) |
| seed 8086, 10 min | all six, 23 each | 138 | 0 |

After `kill -9` of the browser or `Browser.crash`, Chrome damaged its own IndexedDB store in 13 of the 149 browser kills of the last two runs, then deleted every IndexedDB database of the origin or kept failing every open. OPFS was untouched.

Open: in the first 20-minute run, two iterations right after such a wipe failed the prefix check (seed 424242, iterations 59 and 239). In one, an ingested key was gone; in the other, seqs restarted at 1 and the old manifests were gone. That harness then SIGKILLed Chrome's helpers, the storage service among them, the moment the browser process exited. Since it waits for them to exit, 292 iterations (149 of them browser kills, with 13 wipes) found no loss, and a Node test that deletes the WAL between sessions or under an open handle recovers a prefix. The cause, Chrome or the engine, is not known.

## Browser durability facts

| Fact | Source | Limit |
| --- | --- | --- |
| On `close()` of a writable, "It is expected that this atomically updates the contents of the file on disk". `close()` can reject with `AbortError`, and the file is not updated. | [fs.spec.whatwg.org](https://fs.spec.whatwg.org/) | "Expected" is not a guarantee. |
| Chromium moves a swap file onto the target on `Close()`. "In most filesystems, this move operation is atomic." A severed pipe before `Close()` aborts the write. | [file_system_access_file_writer_impl.h](https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_file_writer_impl.h) | No fsync found in the `.cc` (main, 2026-11-06). Whether the swap file is on disk before the move is unverified. |
| `relaxed` commits once changes reach the OS. Chrome 121 made it the default, and the OS buffer "is typically flushed every couple seconds". | [IndexedDB §2.7](https://w3c.github.io/IndexedDB/), [Chrome blog](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/) | Acked writes can be lost on power loss. |
| "Aborting a transaction rolls back any increases to the key generator." | [IndexedDB §2.11](https://w3c.github.io/IndexedDB/) | Gapless seqs depend on it. |
| No spec text orders an IndexedDB commit against an OPFS file move. | none | The stores are independently durable (inferred). |
| SQLite's OPFS VFSs need exclusive sync access handles, so a second tab "will hit a locking error". | [sqlite.org/wasm persistence](https://sqlite.org/wasm/doc/trunk/persistence.md) | Prior art avoids multi-writer OPFS. |

## Not built or not verified

- Technique 4, the StrykerJS and coverage parts of technique 8, and an I/O error injected into recovery after a crash.
- Assertions inside `Memtable` behind a test flag, FoundationDB's `EXPENSIVE_VALIDATION`.
- Power loss on a real disk: whether Chrome fsyncs a swap file before the move, and the order in which IndexedDB and OPFS reach disk.
- IndexedDB under quota in a real browser (verification.md, "Gaps"), and key generator rollback on a commit that a kill cut, in Chrome.
- Browsers other than Chrome.
- The two failed iterations of seed 424242 above.
