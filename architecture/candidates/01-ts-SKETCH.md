# Sketch — TypeScript-native async LSM

Candidate direction: pure TypeScript on the async OPFS API. No WASM core. Bytes KV now. Dexie-shaped tables later, as another package over `Db`.

## (a) Language

TypeScript, strict, target ES2022, lib `DOM` and `WebWorker`. The engine, the byte codec, compaction, and the SharedWorker host are all TypeScript. The published package is JavaScript.

Why this language for this direction:

- The public values are the platform's values: `Uint8Array`, `Promise`, `AsyncIterable`. A caller writes the same types they pass to the façade.
- Async OPFS is promise-shaped (`createWritable`, `close`, `getFile`, `slice`). The engine `await`s those calls directly. Nothing blocks, and nothing needs a sync access handle, so nothing needs a dedicated WebWorker to reach the sync API.
- The tab façade constructs the host with `new SharedWorker(new URL("../host/shared-worker.ts", import.meta.url))`. The app does not ship a separate script, a WASM blob, COOP/COEP headers, or a SharedArrayBuffer.
- The cost is CPU and GC during seal and compaction, and a structured copy across the `MessagePort`. The memtable is a slab plus a B-tree so the hot insert path is not one object per key. Compaction yields between SST blocks so commits still run. "Faster than Dexie" is a bench over this public API, not a claim this sketch proves. The plausible win is group commit of bytes: many operations, one WAL `finish`, no IndexedDB transaction machinery. A solitary `put` still pays one `finish`.

## (b) Module map and ownership

Package exports only `"."` → the public entry. Deep imports fail for dependents. The future tables package depends on `openDb` / `Db` and nothing under `src/host` or `src/store`.

```
src/index.ts                 public exports only
src/tab/db.ts                tab façade: check, idempotency key, port, put/delete → batch
src/errors.ts                ErrorCode and the four error classes. One list.
src/protocol.ts              ClientMessage / HostMessage. Not exported. Uses ErrorCode.
src/check.ts                 the only limit table; produces branded buffers
src/host/shared-worker.ts    SharedWorker entry: onconnect, port map, one Engine per name
src/host/engine.ts           sole owner of mutable DB state and of publication
src/store/memtable.ts        B-tree + slab. No I/O.
src/store/order.ts           compareBytes + successor. Pure. The only key order.
src/store/wal.ts             build and parse WAL files. Does not publish the manifest.
src/store/manifest.ts        load/publish CURRENT. Validates level shape.
src/store/sst.ts             SstFiles: write, lookup, iterate. Block cache is a field.
src/store/merge.ts           async k-way merge + collapse
src/store/codec.ts           putU32 / getU32 / checksum. No record schemas.
src/opfs/async-fs.ts         AsyncFs, FileWriter
src/opfs/browser-fs.ts       the only createWritable caller
src/opfs/memory-fs.ts        test double with the same publish rule
```

Ownership:

| State | Owner | Everyone else |
|---|---|---|
| Active memtable and at most one sealing memtable | `Engine` | reads go through `Engine.get` / `Engine.scan` |
| WAL file publication | `Engine` pump via `wal.ts` | seal/compaction does not write WAL files |
| Manifest / generation / epoch | `Engine` pump via `manifest.ts` | `sst.ts` and `merge.ts` cannot publish |
| SST bytes | `Engine` pump via `sst.ts` | immutable after `finish`; orphans are reclaimed, never adopted |
| Compaction plan, pins, reclaim | `Engine` | no second compactor agent in v0 |
| Writer Web Lock | SharedWorker, held inside `Engine.open` | tabs never request it |
| Generation pin count | `Engine` | generation Web Lock is the cross-agent twin |
| Ports and request ids | `shared-worker.ts` | `Engine` does not see `MessagePort` |
| Idempotency set | `Engine`, derived from WAL headers + manifest list | cap constant sits next to the manifest write |
| Limit numbers | `check.ts` | engine trusts `CheckedOp` and does not re-read limits |

Rule an agent needs: `wal.publish` and `manifest.publish` are called only from `Engine`'s pump. Grep should stay that way. `shared-worker.ts` parses a message, calls one `Engine` method, and writes the response.

OPFS layout for a database `name` (one directory; `name` is a single path segment):

```
name/manifest/CURRENT
name/manifest/g-<generation>
name/wal/e<epoch>-s<seqMin>.wal
name/sst/<sstId>.sst
```

`CURRENT` names the generation body. Readers of files during recovery load `CURRENT` once. While the engine is up, `get` uses the in-memory manifest, not a fresh read of `CURRENT` on each call. `sstId` is assigned by the engine (`<generation>-l<level>-<n>`).

There is no separate `EPOCH` file. The epoch lives in the manifest. One source.

## (c) Types and signatures

Bodies throw `not implemented`. The comments are the behavior.

### Public entry — `src/index.ts`

```ts
export { openDb, prefixBound } from "./tab/db";
export {
  ConstraintError,
  CommitError,
  ClosedError,
  CorruptDatabaseError,
} from "./errors";
export type { Db, BatchTx, Entry, Range, OpenOptions } from "./tab/db";
```

### Errors — `src/errors.ts`

One code list. `HostMessage` uses `ErrorCode`, and each class fixes its own code, so a new failure mode edits this file and then both decode switches fail until they handle it.

```ts
export type ErrorCode = "commit" | "closed" | "corrupt" | "constraint";

export class OpfsLsmError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}
export class ConstraintError extends OpfsLsmError {
  constructor(message: string) { super("constraint", message); }
}
export class CommitError extends OpfsLsmError {
  constructor(message: string) { super("commit", message); }
}
export class ClosedError extends OpfsLsmError {
  constructor(message: string) { super("closed", message); }
}
export class CorruptDatabaseError extends OpfsLsmError {
  constructor(message: string) { super("corrupt", message); }
}
```

### Façade — `src/tab/db.ts`

```ts
export type OpenOptions = { readonly name: string };

export type Range = {
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
  readonly limit?: number;
};

export type Entry = { readonly key: Uint8Array; readonly value: Uint8Array };

export interface BatchTx {
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
}

export interface Db {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  /** `build` runs to completion on this turn. The returned promise settles
   *  after the group WAL file is published and applied. */
  batch(build: (tx: BatchTx) => void): Promise<void>;
  /** Each key at most once, as of iterator creation. Later commits are absent. */
  range(range?: Range): AsyncIterable<Entry>;
  /** Detach this tab. In-flight batches still settle. Bytes stay. */
  close(): Promise<void>;
}

export function prefixBound(prefix: Uint8Array): {
  start: Uint8Array;
  endExclusive?: Uint8Array;
} {
  // TODO: checkKey(prefix). successor() from store/order.ts.
  // Empty prefix → { start: empty } and no endExclusive (full keyspace).
  // A prefix of all 0xFF has no successor; omit endExclusive.
  // Return copies. This is byte arithmetic, not a second scan API.
  throw new Error("not implemented");
}

export function openDb(options: OpenOptions): Promise<Db> {
  // TODO: checkDbName. new SharedWorker(new URL("../host/shared-worker.ts", import.meta.url)).
  // On first message the host has finished recover for this name.
  // put/delete call batch. One wire commit message.
  // Generate one IdempotencyKey per batch (crypto.randomUUID).
  // checkBatch copies into fresh buffers; transfer those copies. The caller's
  // buffer stays usable.
  // If the callback's return value is thenable, throw ConstraintError synchronously.
  // If the port dies before ok, reconnect and resubmit the same key and ops once.
  // CommitError is not retried. Constraint failures throw before the post.
  throw new Error("not implemented");
}
```

### Boundary — `src/check.ts`

```ts
export const LIMITS = {
  keyBytes: 8 * 1024,
  valueBytes: 16 * 1024 * 1024,
  batchOps: 10_000,
  batchBytes: 8 * 1024 * 1024,
} as const;

export type DbName = string & { readonly __brand: "DbName" };
export type CheckedKey = Uint8Array & { readonly __brand: "CheckedKey" };
export type CheckedValue = Uint8Array & { readonly __brand: "CheckedValue" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

export type CheckedOp =
  | { readonly type: "put"; readonly key: CheckedKey; readonly value: CheckedValue }
  | { readonly type: "del"; readonly key: CheckedKey };

/** Copy into a fresh Uint8Array. Reject detached buffers (`buffer.detached`),
 *  oversize keys/values, and a db name that is not `^[A-Za-z0-9_-]{1,64}$`.
 *  Empty keys are allowed. */
export function checkKey(bytes: Uint8Array): CheckedKey {
  throw new Error("not implemented");
}
export function checkValue(bytes: Uint8Array): CheckedValue {
  throw new Error("not implemented");
}
export function checkDbName(name: string): DbName {
  throw new Error("not implemented");
}
export function checkBatch(ops: readonly { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }[]): readonly CheckedOp[] {
  throw new Error("not implemented");
}
```

### Wire — `src/protocol.ts`

Not exported. Discriminated unions. Both decode sites use a `never` default. `ErrorCode` is imported from `errors.ts`.

```ts
export type WireOp =
  | { readonly type: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly type: "del"; readonly key: Uint8Array };

export type ClientMessage =
  | { readonly type: "open"; readonly id: number; readonly name: string }
  | {
      readonly type: "commit";
      readonly id: number;
      readonly name: string;
      readonly idempotencyKey: string;
      readonly ops: readonly WireOp[];
    }
  | { readonly type: "get"; readonly id: number; readonly name: string; readonly key: Uint8Array }
  | {
      readonly type: "range";
      readonly id: number;
      readonly name: string;
      readonly start: Uint8Array | null;
      readonly endExclusive: Uint8Array | null;
      readonly limit: number | null;
    }
  | { readonly type: "close"; readonly id: number; readonly name: string };

export type HostMessage =
  | { readonly type: "ok"; readonly id: number }
  | { readonly type: "value"; readonly id: number; readonly value: Uint8Array | null }
  | {
      readonly type: "range-chunk";
      readonly id: number;
      readonly entries: readonly { key: Uint8Array; value: Uint8Array }[];
      readonly done: boolean;
    }
  | {
      readonly type: "err";
      readonly id: number;
      readonly code: ErrorCode;
      readonly message: string;
    };
```

There is no `put` message and no `seal` message. Adding one is a second write path.

### Files — `src/opfs/async-fs.ts`

```ts
/** A file other readers can see. The stage is not readable. */
export interface FileWriter {
  write(bytes: Uint8Array): Promise<void>;
  /** Publish. Async OPFS `close`. Second finish throws. */
  finish(): Promise<void>;
  /** Drop the stage. It must not become visible. */
  abort(): Promise<void>;
}

export interface AsyncFs {
  /** Published bytes, or undefined if no published file. Never returns a stage. */
  read(path: string, offset: number, length: number): Promise<Uint8Array | undefined>;
  list(dir: string): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  /** Replace the published file only when `finish` resolves. No append. */
  create(path: string): Promise<FileWriter>;
}
```

`browser-fs.ts` maps `create` to `getFileHandle({ create: true }).createWritable()` without `keepExistingData`, `finish` to `close`, `read` to `getFile` + `slice` + `arrayBuffer`. `memory-fs.ts` keeps a published map and a stage map and moves stage → published inside `finish` only.

### Order — `src/store/order.ts`

```ts
/** Unsigned bytewise. The only comparator in the engine. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  throw new Error("not implemented");
}

/** Smallest key strictly after every key that starts with `prefix`, or
 *  undefined when no such bound exists. */
export function successor(prefix: Uint8Array): Uint8Array | undefined {
  throw new Error("not implemented");
}
```

### Memtable — `src/store/memtable.ts`

```ts
export type Seq = number & { readonly __brand: "Seq" };

export type MemHit =
  | { readonly status: "miss" }
  | { readonly status: "tomb" }
  | { readonly status: "value"; readonly value: Uint8Array };

export type Versioned = {
  readonly key: CheckedKey;
  readonly seq: Seq;
  readonly kind: "put" | "del";
  readonly value: Uint8Array;
};

/** Fanout 32. Nodes come from a node arena (integer ids), not one JS object
 *  per key. Leaf entries point at offsets in `slab`. One version per key:
 *  a repeat key overwrites the leaf in place (tombstone is a flag, value
 *  length 0). No removal rebalance. `liveBytes` counts current keys and
 *  values, not abandoned slab garbage. Seal when liveBytes crosses the
 *  engine threshold; slab garbage is left behind for the collector of the
 *  whole memtable. */
export class Memtable {
  static empty(): Memtable {
    throw new Error("not implemented");
  }

  find(key: CheckedKey): MemHit {
    throw new Error("not implemented");
  }

  /** Synchronous. Called only after the WAL file for these ops has finished. */
  apply(ops: readonly Versioned[]): void {
    throw new Error("not implemented");
  }

  /** Key order, values copied, for a stable range snapshot. */
  entriesSorted(): Versioned[] {
    throw new Error("not implemented");
  }

  get liveBytes(): number {
    throw new Error("not implemented");
  }
}
```

### WAL — `src/store/wal.ts`

```ts
export type Epoch = number & { readonly __brand: "Epoch" };

export type WalBatch = {
  readonly idempotencyKey: IdempotencyKey;
  readonly ops: readonly Versioned[];
};

export type WalFile = {
  readonly epoch: Epoch;
  readonly seqMin: Seq;
  readonly seqMax: Seq;
  readonly batches: readonly WalBatch[];
};

export function walPath(epoch: Epoch, seqMin: Seq): string {
  // `wal/e${epoch}-s${seqMin}.wal`
  throw new Error("not implemented");
}

export async function publishWal(fs: AsyncFs, file: WalFile): Promise<void> {
  // TODO: create(walPath).write(encode(file)).finish().
  // encode is private to this module. Header holds epoch, seqMin, seqMax,
  // and the idempotency keys. Records are length-prefixed key/value/kind/seq.
  // On finish() rejection, read the path back; if the checksum matches, return.
  throw new Error("not implemented");
}

export async function readWal(fs: AsyncFs, path: string): Promise<WalFile> {
  // TODO: checksum failure throws CorruptDatabaseError.
  throw new Error("not implemented");
}
```

### Manifest — `src/store/manifest.ts`

```ts
export type Generation = number & { readonly __brand: "Generation" };
export type SstId = string & { readonly __brand: "SstId" };

export type SstMeta = {
  readonly id: SstId;
  readonly smallest: CheckedKey;
  readonly largest: CheckedKey;
  readonly seqMin: Seq;
  readonly seqMax: Seq;
  readonly bytes: number;
};

export type Manifest = {
  readonly generation: Generation;
  readonly epoch: Epoch;
  /** Every seq <= sealedThrough is in some SST. 0 means nothing is sealed. */
  readonly sealedThrough: Seq;
  /** Capped. Unsealed WAL headers hold the keys not yet listed here. */
  readonly idempotency: readonly IdempotencyKey[];
  /** levels[0] is L0, newest at index 0, overlap allowed.
   *  levels[i] for i > 0 is sorted by smallest and non-overlapping. */
  readonly levels: readonly (readonly SstMeta[])[];
};

export function validateManifest(manifest: Manifest): void {
  // TODO: walk levels with compareBytes. Throw CorruptDatabaseError.
  throw new Error("not implemented");
}

export async function loadManifest(fs: AsyncFs, dbDir: string): Promise<Manifest | undefined> {
  // TODO: missing CURRENT → undefined (empty database). Else read the named
  // generation body and validateManifest.
  throw new Error("not implemented");
}

/** Write `manifest/g-<generation>` then `manifest/CURRENT`. A crash after the
 *  body and before CURRENT leaves the previous generation in force. */
export async function publishManifest(fs: AsyncFs, dbDir: string, manifest: Manifest): Promise<void> {
  // TODO: validateManifest first. Caller is the engine pump only.
  throw new Error("not implemented");
}
```

### SST and merge — `src/store/sst.ts`, `src/store/merge.ts`

```ts
/** Engine constructs one `SstFiles` and drops cache entries when it reclaims an id.
 *  The cache is a field here, not a module global: it remembers file bytes, not
 *  which SST ids are live. */
export class SstFiles {
  constructor(private readonly fs: AsyncFs) {}

  /** `entries` is one version per key, in key order, and may be large.
   *  Length-prefixed records. Block size 64 KiB is private to this class.
   *  Footer points at a block index (first key → file offset).
   *  Stream blocks through FileWriter. `finish` once.
   *  No Bloom filter and no prefix compression; those stay inside this class. */
  write(path: string, entries: AsyncIterable<Versioned>): Promise<SstMeta> {
    throw new Error("not implemented");
  }

  /** Outside `[smallest, largest]` returns miss without a read.
   *  Read the block index once, then one data block via `fs.read`. */
  lookup(path: string, meta: SstMeta, key: CheckedKey): Promise<MemHit> {
    throw new Error("not implemented");
  }

  iterate(
    path: string,
    meta: SstMeta,
    range: { start?: CheckedKey; endExclusive?: CheckedKey },
  ): AsyncIterable<Versioned> {
    throw new Error("not implemented");
  }

  forget(id: SstId): void {
    throw new Error("not implemented");
  }
}

// --- src/store/merge.ts. Pure. No AsyncFs. sst.ts calls collapse when it builds a file. ---

/** Newest seq wins. A tombstone drops the key when `dropTombstones`. */
export function collapse(
  newestFirst: readonly Versioned[],
  dropTombstones: boolean,
): Versioned | undefined {
  throw new Error("not implemented");
}

/** Async because SST sources are range reads. Key order via `compareBytes`,
 *  then seq descending within a key. The memtable snapshot is just another
 *  source: yield `entriesSorted()` from an async iterable. One merge. */
export function mergeIters(
  sources: ReadonlyArray<AsyncIterable<Versioned>>,
): AsyncIterable<Versioned> {
  throw new Error("not implemented");
}
```

### Engine — `src/host/engine.ts`

```ts
const SEAL_BYTES = 8 * 1024 * 1024;
const HARD_CAP_BYTES = 16 * 1024 * 1024;
const L0_COMPACT_COUNT = 4;
const LEVEL_FANOUT = 10;
const IDEMPOTENCY_CAP = 4096;

export type CommitInput = {
  readonly idempotencyKey: IdempotencyKey;
  readonly ops: readonly CheckedOp[];
};

export class Engine {
  /** Acquire exclusive Web Lock `opfs-lsm/${name}/writer` and hold it until
   *  `close`. Run recover before returning. */
  static open(fs: AsyncFs, name: DbName): Promise<Engine> {
    throw new Error("not implemented");
  }

  /** Latest acknowledged value. Tombstone and miss are both undefined. */
  get(key: CheckedKey): Promise<Uint8Array | undefined> {
    // TODO:
    // hit = readMem(active) then readMem(sealing). If not miss, return it
    //   (copy bytes; tomb → undefined).
    // Pin the current generation (count += 1, then shared Web Lock
    //   `opfs-lsm/${name}/gen/${generation}`).
    // Snapshot the SstMeta list: L0 newest-first, then each deeper level
    //   binary-searched because it does not overlap.
    // After every await, recheck readMem. Memtables are newer than SSTs.
    // Release the pin in a finally.
    throw new Error("not implemented");
  }

  /** Stable snapshot: copy memtables with entriesSorted() at creation, pin
   *  the generation, merge with SST iterators, skip tombstones, honor limit.
   *  Iterator return() releases the pin. */
  scan(range: {
    start?: CheckedKey;
    endExclusive?: CheckedKey;
    limit?: number;
  }): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    throw new Error("not implemented");
  }

  commit(input: CommitInput): Promise<void> {
    // TODO: if idempotencyKey is already applied, resolve immediately.
    // Else enqueue and kick the pump. The promise resolves only from the pump,
    // after publishWal and synchronous memtable.apply.
    // Empty ops: resolve without a file.
    throw new Error("not implemented");
  }

  /** Stop the pump after the current unit. Release the writer lock.
   *  The SharedWorker usually keeps the engine for the next tab; the host
   *  calls this when the SharedWorker is going away, not when one tab detaches. */
  close(): Promise<void> {
    throw new Error("not implemented");
  }
}
```

Pump, private, one loop. Commits outrank SST bytes. One unit of work, then a macrotask (`setTimeout(0)`) so port messages enqueue before the next block.

```ts
// private pump(this):
// TODO: one unit, then return to the top. Never busy-wait: the pump is the
// only publisher, so a commit must not wait on a seal that this same function
// has stopped running.
// 1. If sealing === null && active.liveBytes >= SEAL_BYTES:
//      Move active to sealing. active = Memtable.empty().
//      Open an SstFiles.write job for an async iterable of sealing.entriesSorted(),
//      new sst id, L0. A second sealing memtable is forbidden.
// 2. If the commit queue is non-empty:
//      Await one macrotask so commits already posted can join.
//      Drop inputs whose idempotencyKey is already applied; resolve those.
//      While a seal is in progress, take only a prefix of the queue that keeps
//      active.liveBytes <= HARD_CAP_BYTES. Leave the rest queued.
//      With no seal in progress, take the whole queue (step 1 already sealed
//      a full active memtable). One batch is at most SEAL_BYTES.
//      If the prefix is empty, skip to step 3.
//      Assign seqs from this.nextSeq. Never reuse a seq after a failed finish.
//      await publishWal. On throw: reject this prefix; do not apply.
//      memtable.apply synchronously on `active`. Remember keys. Resolve.
//      Return to the top.
// 3. If an SST job is open (seal or compaction):
//      Write one block, or finish the file when the iterable is done.
//      On finish: publishManifest (generation + 1). Advance sealedThrough only
//      for a seal. idempotency list = the last IDEMPOTENCY_CAP keys.
//      Only after CURRENT finishes: remove WAL files with seqMax <= sealedThrough,
//      and SST ids no pinned manifest names (pin count 0, then exclusive
//      ifAvailable on that generation's lock). sst.forget(id) for each.
//      Return to the top.
// 4. If plan() returns a compaction, open it and return to the top.
//      Provisional plan: levels[0].length >= L0_COMPACT_COUNT merges those SSTs
//      with the overlapping SST in the next level. Deeper levels compact when
//      their bytes exceed FANOUT times the previous target. dropTombstones only
//      when no older level could still hold the key.
// 5. Stop until the next commit() kick.
```

Recovery, private, runs inside the writer lock before `open` resolves:

```ts
// private recover():
// TODO:
//   manifest = (await loadManifest()) ?? empty epoch 0, generation 0, no levels.
//   seen = await list("wal") once.
//   Replay seen files whose epoch === manifest.epoch and seqMax > sealedThrough,
//     in seq order, skipping records with seq <= sealedThrough.
//     Checksum failure → CorruptDatabaseError. Do not skip a bad published file.
//   Build applied idempotency from manifest.idempotency + replayed headers.
//   nextSeq = max replayed seq (or sealedThrough) + 1.
//   If the rebuilt memtable is non-empty:
//     publishWal of that memtable at epoch manifest.epoch + 1, same seqs.
//   publishManifest epoch + 1, same SST set, generation + 1, same sealedThrough.
//   Only then remove WAL files whose epoch !== the new epoch.
//   SST files whose ids are not in the manifest stay on OPFS until reclaim.
//   Do not open them and do not add them to levels. One recovery path: WAL replay.
//   Ignore any WAL file that appears after `seen`. It is a zombie close of an
//   unacknowledged group, and its epoch is already stale once the new manifest
//   has finished.
//   this.epoch = new epoch. this.active = replayed memtable. this.sealing = null.
```

`readMem` is the synchronous active-then-sealing lookup. It is the only memtable read `get` uses.

Host (`src/host/shared-worker.ts`):

```ts
// onconnect → port.onmessage:
// TODO: switch (msg.type) with a never default.
//   "open": one in-flight Promise per name. Concurrent first connects share it.
//           engines.get(name) ?? (opening.set(name, Engine.open(...)))
//   "commit": engine.commit({ idempotencyKey, ops: checkBatch(ops) })
//   "get": engine.get(checkKey(key)) → { type: "value", value: bytes ?? null }
//   "range": pump engine.scan into range-chunk messages; iterator.return() if the
//            port closes or the tab sends close.
//   "close": this port only. Do not Engine.close while another port or a future
//            connect can still arrive. The browser tears the SharedWorker down.
// Respond with { code: err.code } from OpfsLsmError. Do not switch on class names.
// A commit rejection means that prefix was not applied.
```

## (d) Concurrency stance

Single writer. The writer is the engine object inside the origin's SharedWorker. It is the only agent that creates WAL files, SST files, or manifest files for a database.

Tabs run `openDb` on the main thread. That thread does not open OPFS. A frozen or throttled tab freezes its façade and does not freeze the SharedWorker, so other tabs keep committing. There is no leader, no follower, and no broker, and there is no election: the exclusive writer Web Lock is held by the SharedWorker for the life of the engine, and a new incarnation recovers when the previous agent is gone and the lock releases. Web Locks are not a health check; a zombie `close` is fenced by the epoch bump in `recover`, not by the lock timing out.

| Work | Where it runs |
|---|---|
| `Db` methods, validation, port | Tab main thread |
| Memtable, WAL `finish`, manifest `finish`, `get`, `scan` | SharedWorker, `Engine` |
| Seal and compaction | Same SharedWorker, same pump, one SST block then a macrotask |
| Sync API / sync access handle | Unused |
| Dedicated WebWorker | Unused in v0 |
| ServiceWorker | Unused |

Two memtables exist only across a seal: `active` takes commits, `sealing` is immutable and is the one being written out. `get` consults both. No second tab holds either structure.

Group commit is the cross-tab batch: every `CommitInput` queued when the pump publishes shares one WAL file and one total order. Order is `seq`, global, allocated by this engine.

Visibility after acknowledgement: the applying agent is the reading agent. Another tab's `get` is a message to that agent. Nothing is shipped to other tabs to make a write visible. A fresh SharedWorker sees the write because `finish` happened before the promise resolved, and `recover` replays that file.

Compaction does not commit user writes. It publishes a generation whose SST set is equivalent to the previous set plus a sealed memtable, and it does that on the same pump that would otherwise be in the middle of a user `finish`. The pump never interleaves a manifest publish with a half-applied memtable: `apply` is synchronous and sits between awaits.

Reclaim races: a scan pins a generation before its first await. Pin count is incremented synchronously. Reclaim of that generation waits until the count is zero, then takes the exclusive generation lock with `ifAvailable`. The same agent does not request that exclusive lock while it still holds the shared one.

Tab death after a resolved promise: the SharedWorker still holds the memtable and the WAL file. Tab death before `ok`: a later `openDb` on that tab resubmits the same idempotency key; if the tab never returns, the bytes are still durable once `finish` has succeeded. SharedWorker death after `finish` and before apply: the next `open` replays the file. SharedWorker death before `finish`: the stage is not published; the retry writes a new file with new sequence numbers.

## (e) Deliberately deferred

- Tables, object stores, schema versions, secondary indexes, ordered JS codecs. They call `batch` and `range` on this `Db`. The engine grows no comparator and no value type.
- Interactive transactions and `get` inside `batch`. v0 batches are write-only and synchronous. A later `transaction()` is a new method with its own snapshot, not a second `batch`.
- Live queries. The pump is the place a subscriber list would run, after `apply`, pushing on ports the host already holds. Not a second read loop.
- Bloom filters, prefix-compressed keys, and a block cache beyond the current SST index. All inside `sst.ts` if a bench says so.
- A tab-local snapshot cache. v0 has one read path, through the SharedWorker.
- A public `commitDelay`, durability mode, or compaction option. Tuning constants stay private.
- `Engine.close` on last-port disconnect. The SharedWorker keeps the engine until the browser destroys it, so the next tab does not pay an epoch bump just because one page navigated. If the browser does destroy it, `recover` is the startup path.
- Benchmarks. A `bench/` harness should call only `openDb` and Dexie: group insert, solitary `put`, point `get`, prefix `range`. It is not an engine module.
- Adopting orphan SSTs, per-put manifest publishes, append to an existing WAL, and any main-thread OPFS handle.

## Alternatives rejected inside this direction

- **Main-thread-only engine.** Freeze and jank follow the tab, and a second tab is a second writer. One way to commit means the commit does not live where the page can also open the file.
- **Per-tab dedicated WebWorkers as writers, SharedWorker as compactor only.** Per-tab memtables would merge at read, which is the right default if tabs write. They do not write here. The SharedWorker can hold the only memtable without freezing when a background tab freezes, so the merge protocol stays out of v0.
- **A dedicated WebWorker that only writes SST bytes.** Better isolation of a long merge, and a second `createWritable` caller on day one. The pump's block yield is the v0 answer. Splitting the runner later means changing where `writeSst` is called, not adding a plugin interface now.
- **One growing WAL opened with `keepExistingData`.** Publication cost tracks the file size. `AsyncFs.create` replaces a file by finishing a new stage; it cannot append.
- **SharedArrayBuffer memtable or a user comparator in the engine.** Cross-origin isolation, or Dexie types inside every SST. Byte keys and a tables package keep that knowledge in one future module.
