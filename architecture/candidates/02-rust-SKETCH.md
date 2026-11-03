# Sketch — Rust → WASM async LSM

Contract for the candidate. Bodies are `todo!()` / `not implemented`. Usage in `DESIGN.md` is the spec; these signatures exist to serve it.

## (a) Language split

**Rust `engine-core` (no `wasm-bindgen`, no DOM).** Memtable, WAL record framing, checksums, SST build/read, Bloom filter, compaction merge, manifest codec, overlay planner, epoch checks, compaction-job derivation, reclaim set. Pure functions of bytes plus one in-memory engine value.

**Rust `engine-wasm`.** `wasm-bindgen` exports of three opaque classes and the generated intent/error enums. Private workspace crate. Not an app dependency.

**TypeScript `@opfs-lsm/kv` (the only published entry).** Async OPFS, dedicated WebWorker per tab, SharedWorker broker and compactor host, public `Kv`. Later `@opfs-lsm/collections` encodes Dexie-shaped keys and calls `Kv` only.

Why this split: checksums, merge, and binary search are where a JS engine pays GC and where a mistake becomes silent corruption. OPFS publication, Web Locks, and worker lifetime are JS platform objects; pulling them into Rust via `web-sys` would glue the engine to one browser and would recreate `SyncFile` inside WASM. The façade stays TS because that is the Dexie caller's language and the worker wiring's language.

Why not a sync I/O trait: `SyncFile` is blocking, positional, and single-file. This engine never mutates a byte range in place. It publishes a new immutable object or reads a range. The engine does not declare a storage trait at all.

## Alternatives rejected inside this direction

- Sync-handle LSM on `SyncFile` in one dedicated WebWorker.
- One monolith WASM instance on the main thread, no workers.
- Leader-tab `WriterEngine` with follower RPC (sync B+tree coordination around an LSM core).
- `web-sys` OPFS calls inside the engine crate.
- An `ObjectStore` trait awaited from Rust, with policy split between the trait and the shell.
- One engine type gated by a role flag (writer could reach manifest publish).

## (b) Module map

```text
opfs-lsm/
  crates/engine-core/          private lib, native tests
    src/key.rs                 UserKey ordering (unsigned bytes)
    src/wal.rs                 record framing + checksum  (one codec)
    src/memtable.rs            BTreeMap for one batch
    src/sst.rs                 build + read runs (L0 one-block and multi-block)
    src/compact.rs             merge iterator
    src/manifest.rs            codec, apply, overlay, job derivation, reclaim set
    src/writer.rs              WriterEngine
    src/owner.rs               ManifestEngine
    src/compactor.rs           CompactorEngine
    src/intent.rs              IoIntent, IoCompletion
  crates/engine-wasm/          private, depends on engine-core
    src/lib.rs                 WasmWriter, WasmManifest, WasmCompactor
  packages/kv/                 npm @opfs-lsm/kv
    src/index.ts               exports openKv, Kv, View, BatchOp, KvError ONLY
    src/kv.ts                  sugar → one message type; no second client class
    src/driver.ts              tab queue, intent loop, ack rule
    src/opfs_adapter.ts        async OPFS publish / slice / list / delete
    src/broker.ts              SharedWorker: lock, proposals, pins, reclaim
    src/compactor_host.ts      runs a job's intents; does not pick inputs
    src/worker.ts              dedicated WebWorker entry
    src/shared_worker.ts       SharedWorker entry
```

`package.json` `"exports"` is `"."` only. `engine-wasm` is `"private": true` and is not re-exported. Codecs are `pub(crate)`. An app import of an intent type fails the build.

| Module | Writes | Reads | Must not |
| --- | --- | --- | --- |
| `WriterEngine` | this tab's memtable; L0 byte source | manifest bytes handed in by the driver | publish a generation; open OPFS |
| `ManifestEngine` | in-memory generation; next generation's bytes | proposal list | touch handles or locks |
| `CompactorEngine` | new SST byte source | job + range bytes | choose inputs; edit the manifest |
| `OpfsAdapter` | file bytes via `createWritable` + `close` | `getFile` + `slice` | checksum algorithm; key order |
| `driver.ts` | the tab's single-flight queue | intents | encode records itself |
| `broker.ts` | Web Lock hold; the decision to `close` the generation file | proposals, pin set | SST layout |
| future collections | nothing on OPFS | `Kv` only | a second writer path |

One list of run kinds, error codes, and intent tags: the Rust enums. wasm-bindgen generates the TS. Do not hand-write a parallel union.

## (d) Concurrency stance

Multi-writer. Single manifest owner. Compactor is a guest of that owner.

```text
Page
  Kv  --postMessage Batch|View-->  Dedicated WebWorker (freezes with the tab)
                                     driver queue (one op at a time)
                                     WasmWriter
                                     OpfsAdapter     publishes l0/<id>.sst
                                     port ----------> SharedWorker (not frozen with one tab)
                                                        broker holds manifest-owner lock
                                                        WasmManifest  only publisher of m/<gen>
                                                        compactor host + WasmCompactor
                                                          publishes compacted SSTs
                                                          submits CompactionProposal
```

- Many tabs publish distinct L0 objects. They never write `m/`.
- The broker serializes proposals. Apply order is the total order. Newer run overlays older run per key. Tombstone wins until compacted away.
- Each writer has a `WriterId` (u128) and an `Epoch` from the broker. Stale epochs are rejected. A zombie can still `close` an L0 object; it cannot get that object named.
- v0 hosts `ManifestEngine` and `CompactorEngine` only in the SharedWorker. If that agent is gone, new batches fail `no_owner`. A tab does not take the lock: a freeze would not release it.
- Snapshot pin: shared Web Lock `snap/<db>/<generation>` held for the `view` callback. Reclaim: broker asks for exclusive `ifAvailable` on generations the manifest no longer needs, then deletes only names `ManifestEngine::unreferenced` returned.
- Same-tab operations are a queue. No memtable is shared with another agent. After ack, the writer's copy of the keys lives only in the named run.

Ack rule, in one place (`driver.ts`): the `batch` promise resolves on the broker's ack message, which the broker sends only after the generation file `close` succeeds. L0 `close` alone does not resolve it.

## (e) WASM / JS boundary

**Crosses, as copies or integers.** Batch ops (key and value bytes). Generated `IoIntent` / `IoCompletion`. Generation `u64` as `bigint`. Proposal bytes encoded by `engine-core` (`proposal::encode`); the broker passes those bytes into `WasmManifest` and does not build a JS manifest object. Result bytes for `get` / `range`. `MAX_BATCH_BYTES` exported from Rust so the shell's friendly check is not a second constant.

**Must not cross.** `FileSystemFileHandle`, writable streams, Web Lock grants, `DOMException`. Memtable maps. SST block layout, Bloom bits, checksum seeds. A JS object shape of the manifest. Any method named `flush` or `writeAt`.

**Publish path.** Engine keeps the sealed bytes (L0, bounded by `MAX_BATCH_BYTES`) or the compaction cursor (multi-block). Shell pulls `next_chunk` (64 KiB, constant inside the adapter) and writes the stream. Engine never sees the stream.

**Read path.** Engine requests exact ranges. Adapter may coalesce OPFS reads and must split buffers back to those ranges before `resolve`. Short reads are `None` payloads; the engine decides corrupt vs miss.

Validate at the adapter: object names match `^(l0|sst|m)/[A-Za-z0-9._-]+$` and stay under the database directory. After that, core trusts `UserKey` and `Generation` newtypes.

## (c) Type and signature sketch

Domain types (`engine-core`). Invariants in the types: `UserKey` is opaque bytes with unsigned lexicographic `Ord`. `Generation` is a newtype `u64`, not a bare integer at the apply boundary. `RunRef` is the only way a run is named inside a generation. `BatchOp` carried into Rust is already a put or a delete, not a stringly mode.

```rust
pub struct UserKey(/* private */ Vec<u8>);
pub struct Generation(u64);
pub struct WriterId(u128);
pub struct Epoch(u64);

pub struct ProposalId {
    pub writer: WriterId,
    pub epoch: Epoch,
    pub batch: u64,
}

pub enum ValueCell { Put(Vec<u8>), Delete }

pub struct RunRef {
    name: String,       // crate-visible; not a public KV type
    level: u32,         // 0 = L0 segment, >0 compacted and non-overlapping
    smallest: UserKey,
    largest: UserKey,
    len: u64,
    checksum: u64,
}

pub struct Manifest {
    generation: Generation,
    epochs: BTreeMap<WriterId, Epoch>,
    runs: Vec<RunRef>,           // overlay order: newest L0 .. oldest L0, then L1+
    applied: BTreeSet<ProposalId>,
    applied_jobs: BTreeSet<CompactionId>,
}
```

On-disk, private to `wal.rs` + `sst.rs`: little-endian records `(tag, key_len, key, value_len, value)`, xxh3 over the record, SST footer with index offset and file checksum. L0 is that format with one data block and no Bloom filter. Compacted files add a block index and a Bloom filter over user keys. One reader, `sst::RunReader`. Do not add `WalReader`.

```rust
pub enum IoIntent {
    Publish { name: String, publish_id: u32, total_len: u64 },
    Read { read_id: u32, ranges: Vec<RangeReq> },
    Delete { name: String },
    List { prefix: String, list_id: u32 },
}

pub struct RangeReq { pub name: String, pub offset: u64, pub len: u32 }

pub enum IoCompletion {
    Published { name: String, len: u64 },
    Ranges { read_id: u32, payloads: Vec<Option<Vec<u8>>> },
    Listed { names: Vec<(String, u64)> },
    Deleted { name: String },
}
```

```rust
pub struct WriteBatch { pub ops: Vec<(UserKey, ValueCell)> }

pub struct CommitProposal {
    pub id: ProposalId,
    pub expected: Option<Generation>,
    pub segments: Vec<RunRef>,
}

pub struct CompactionId(/* hash of input names + base generation */ u128);

pub struct CompactionJob {
    pub id: CompactionId,
    pub base: Generation,
    pub inputs: Vec<RunRef>,
    pub output_name: String,
    pub output_level: u32,
}

pub struct CompactionProposal {
    pub id: CompactionId,
    pub base: Generation,
    pub drop: Vec<String>,
    pub add: Vec<RunRef>,
}

pub struct Sealed {
    pub intents: Vec<IoIntent>,
    pub proposal: CommitProposal,
}

pub struct WriterEngine { /* memtable, epoch, sealed buffer, manifest view */ }
pub struct ManifestEngine { /* current: Manifest */ }
pub struct CompactorEngine { /* merge cursor for one job */ }

impl WriterEngine {
    pub fn register(&mut self, id: WriterId, epoch: Epoch) { todo!() }

    /// Empty keys are allowed. Duplicate keys in one batch fold to the last op.
    /// Reject encoded size > MAX_BATCH_BYTES.
    pub fn seal(&mut self, batch: WriteBatch) -> Result<Sealed, EngineError> {
        todo!() // Sealed { intents: [Publish l0/<proposal>], proposal }
    }

    pub fn next_chunk(&mut self, publish_id: u32, max: usize) -> Option<Vec<u8>> {
        todo!()
    }

    pub fn note_committed(&mut self, generation: Generation, id: ProposalId) -> Result<(), EngineError> {
        todo!() // drop memtable; install manifest view the broker returns
    }

    pub fn prepare_read(&mut self, manifest_bytes: &[u8]) -> Result<(), EngineError> { todo!() }

    pub fn plan_get(&mut self, key: &UserKey) -> Result<ReadStep, EngineError> { todo!() }
    pub fn plan_range(&mut self, start: Bound<&UserKey>, end: Bound<&UserKey>, limit: Option<u32>)
        -> Result<ReadStep, EngineError> { todo!() }

    pub fn resolve(&mut self, done: IoCompletion) -> Result<ReadStep, EngineError> { todo!() }
}

pub enum ReadStep {
    Need(Vec<IoIntent>),
    Value(Option<Vec<u8>>),
    Rows(Vec<(UserKey, Vec<u8>)>),
    Done,
}

impl ManifestEngine {
    pub fn recover(files: &[(String, Vec<u8>)]) -> Result<Self, EngineError> {
        todo!() // highest generation whose checksum and prev-link validate; ignore torn files
    }

    pub fn apply_commit(&mut self, p: CommitProposal) -> Result<GenerationBytes, EngineError> {
        todo!()
        // TODO: if applied contains p.id -> Ok(existing generation) even when expected is stale.
        // TODO: else if expected is Some(g) && g != current -> Err(StaleGeneration).
        // TODO: else if epoch < recorded epoch -> Err(StaleEpoch).
        // TODO: else if l0_count >= L0_CEILING -> Err(Backpressure) and do not publish.
        // TODO: else append segments in proposal order, write generation+1 bytes, record id.
    }

    pub fn apply_compaction(&mut self, c: CompactionProposal) -> Result<GenerationBytes, EngineError> {
        todo!()
        // TODO: same job id -> Ok. Inputs must still be named. Swap in one generation.
    }

    pub fn next_job(&self) -> Option<CompactionJob> {
        todo!() // TODO: if L0 count > 4, one job that merges the oldest overlapping L0s into L1.
    }

    pub fn unreferenced(&self, pinned: &[Generation]) -> Vec<String> {
        todo!() // names no pinned generation's manifest still lists, and current does not list
    }
}
```

`GenerationBytes` is the encoded file plus the generation number. The broker publishes that file and only then updates its in-memory `ManifestEngine` — or, simpler and crash-safer: publish, then `recover` from the bytes just written so RAM is derived from the file. One source of truth: the generation file. RAM is a cache filled by `recover`.

```rust
impl CompactorEngine {
    pub fn start(&mut self, job: CompactionJob) -> Result<Vec<IoIntent>, EngineError> { todo!() }
    pub fn next_chunk(&mut self, publish_id: u32, max: usize) -> Option<Vec<u8>> { todo!() }
    pub fn resolve(&mut self, done: IoCompletion) -> Result<CompactionProgress, EngineError> { todo!() }
    // CompactionProgress::Proposal(CompactionProposal) when the output is fully pulled
    // and its checksum is known. CompactorEngine does not apply it.
}
```

Public TS, matching the usage section. `put` / `delete` / `get` are sugar in this file and nowhere else.

```ts
export type BatchOp =
  | { type: "put"; key: Uint8Array; value: Uint8Array }
  | { type: "delete"; key: Uint8Array };

export type RangeBounds = {
  start?: Uint8Array;
  end?: Uint8Array;
  limit?: number;
};

export function openKv(name: string): Promise<Kv> {
  throw new Error("not implemented");
}

export class Kv {
  batch(ops: BatchOp[], opts?: { ifGeneration?: bigint }): Promise<void> {
    throw new Error("not implemented");
    // posts { kind: "batch", ops, ifGeneration } to this tab's dedicated WebWorker
  }
  put(key: Uint8Array, value: Uint8Array): Promise<void> {
    return this.batch([{ type: "put", key, value }]);
  }
  delete(key: Uint8Array): Promise<void> {
    return this.batch([{ type: "delete", key }]);
  }
  view<T>(fn: (view: View) => Promise<T> | T): Promise<T> {
    throw new Error("not implemented");
    // TODO: const current = await broker.current()  // { generation, manifestBytes }
    // TODO: take shared Web Lock snap/<name>/<generation> for this callback only.
    // TODO: try { return await fn(new View(current)) } finally { release the lock }
    // TODO: View.get / View.range post view-* carrying current.generation, not "latest".
  }
  changes(): AsyncIterable<bigint> {
    throw new Error("not implemented");
  }
  close(): Promise<void> {
    throw new Error("not implemented");
  }
}

export class View {
  /** Generation captured when `view` started. Stable for the callback. */
  generation(): bigint {
    throw new Error("not implemented");
  }
  get(key: Uint8Array): Promise<Uint8Array | null> {
    throw new Error("not implemented");
  }
  range(bounds: RangeBounds): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    throw new Error("not implemented");
  }
}
```

Worker message union, one handler each, not exported from the package:

```ts
type WorkerRequest =
  | { kind: "batch"; ops: BatchOp[]; ifGeneration?: bigint }
  | { kind: "view-get"; generation: bigint; key: Uint8Array }
  | { kind: "view-range"; generation: bigint; bounds: RangeBounds };
```

Driver, the ack rule and the only intent loop on the tab. Pseudocode is the logic to implement, not a second design.

```ts
async function handleBatch(ops: BatchOp[], ifGeneration?: bigint): Promise<void> {
  // TODO single-flight: this function is the queue body, never re-entered.
  const sealed = writer.seal(ops); // wasm
  // TODO pull next_chunk until null, adapter.publish(name, stream).
  //      createWritable() without keepExistingData. close() is the durability barrier.
  //      on failure: do not submit; leave the partial file for later reclaim.
  const ack = await broker.submit(sealed.proposalBytes, ifGeneration);
  // TODO ack is { generation } only after SharedWorker closed m/<generation>.
  writer.noteCommitted(ack.generation, sealed.proposalId);
}

async function handleViewGet(generation: bigint, key: Uint8Array): Promise<Uint8Array | null> {
  // TODO fetch manifest bytes for `generation`, never broker.current().
  //      A commit that lands mid-callback must not appear in this view.
  const manifest = await broker.manifest(generation);
  writer.prepareRead(manifest);
  let step = writer.planGet(key);
  while (step.kind === "need") {
    const done = await adapter.fulfill(step.intents); // coalesce inside adapter
    step = writer.resolve(done);
  }
  return step.value;
}
```

Broker apply, SharedWorker only:

```ts
async function submit(proposalBytes: Uint8Array): Promise<{ generation: bigint }> {
  // TODO hold exclusive Web Lock `manifest-owner` for the life of this agent.
  // TODO manifest.apply_commit -> GenerationBytes (Rust).
  // TODO adapter.publish(`m/${gen}`) then close.
  // TODO on close failure: do not bump RAM; recover() from the directory listing
  //      so a torn file is ignored. Return the error to the writer.
  // TODO on close success: broadcast generation on every tab port, then return.
}
```

`View` methods throw `closed` if called after the `view` callback settles. The pin is taken before the callback and released in a `finally`. Range iteration must be awaited inside the callback; the pin covers that because it covers the callback's promise.

Layout under the OPFS directory `opfs-lsm/<name>/`:

```text
l0/<writerId>_<epoch>_<batchSeq>.sst
sst/<compactionId>.sst
m/<generation:016>.mft
```

No `CURRENT`. No append to an existing file. No `keepExistingData`.

## (f) Deliberately deferred

- `@opfs-lsm/collections`: store ids, index ids, compound-key encoding, live queries on top of `changes()` + `view`. Engine stays byte-order only.
- Tab failover for the manifest owner (heartbeat, steal). v0 fails writes closed when the SharedWorker is dead.
- Overflow objects for huge values.
- Group commit that delays ack across separate awaits.
- A native filesystem driver. If it appears later it is another completion feeder, not a `SyncFile` impl inside `engine-core`.
- Leveled compaction beyond "merge excess L0 into one L1 run." The `level` field is in the manifest now so the picker can change without a second format.
- Benchmarks versus Dexie. First bench is the same `batch` / `view` workload; not a second public API.
- MVCC and per-key sequence numbers.

## Red-flag screen

- **Shallow module.** App surface is `batch` / `view` / `changes` / `close`. The intent enum is wide and is not exported. Learning `Kv` does not require learning SST footers.
- **Information leakage.** One record codec, one manifest codec, one proposal encoding. OPFS types stay in `opfs_adapter.ts`. The façade will own prefix layout later; `engine-core` has no store id.
- **Temporal decomposition.** Modules are memtable, run format, manifest, adapter, tab driver, broker. Not load/validate/save stages. `driver.ts` completes a batch; it does not forward to a `save.ts`.
- **Pass-through.** `put` → `batch` is a one-line wrap onto the only worker handler. There is no `WorkerClient` with the same methods as `Kv`. Broker `submit` adds the generation `close` and the lock, which the driver does not do.
- **Split ownership.** Only `ManifestEngine` produces generation bytes. Only the writer produces its L0 bytes. Only the compactor produces compacted SST bytes. Pins are broker state derived from the generation number.
- **Two ways.** One write message (`batch`), one read message family (`view`), one run reader, one recovery function (`ManifestEngine::recover`). Unconditional and conditional commits share `apply_commit`.
- **Importable internals.** Package exports and `pub(crate)` codecs. Worker protocol types are not in `index.ts`.
- **Hand-synced list.** Run levels, errors, and intents are Rust enums exported once. `MAX_BATCH_BYTES` and the L0 ceiling are Rust constants read from WASM, not copied into TS.
