import fc from "fast-check";
import { expect } from "vitest";
import { ClosedError, type ChangeEvent, type ChangeOp, type Db, type Entry } from "../../src/index.js";
import {
  openHarnessDb,
  destroyHarnessDb,
  ingest,
  type AsyncFs,
  type RemovableFs,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../../src/testing.js";
import { checkDatabase, deleteWal, walMeta } from "./check-database.js";
import { loadGeneration } from "../../src/store/generation.js";
import { compareBytes } from "../../src/bytes.js";
import { applyOps, Oracle, Reader, show, type OracleEntry, type OracleOp, type OracleRange, type ViewCheck } from "./oracle.js";
import { compactHost } from "../compact-host.js";

/**
 * fast-check commands for one `Db` handle over MemoryFs and fake-indexeddb,
 * checked against the oracle. See docs/research/corruption-hardening-test-suite.md,
 * technique 1.
 */

export class Model {
  readonly oracle = new Oracle();
  readonly reader = new Reader(this.oracle);
  /** Makes every written value distinct, so a read maps back to the write. */
  private nextValue = 1;
  /** Values reads handed out since the last read command, each with the bytes it had. */
  private handed: [Uint8Array, Uint8Array][] = [];

  /** Keep a value a read handed out, to check at the next read command. */
  hand<T extends Uint8Array | undefined>(value: T): T {
    if (value) this.handed.push([value, value.slice()]);
    return value;
  }

  /**
   * Every value a read hands out is a copy the caller may change (README,
   * "Reads and writes"): the commands since did not change it, and the
   * caller changing it now changes nothing a later read returns.
   */
  scribble(): void {
    for (const [value, was] of this.handed) {
      if (compareBytes(value, was) !== 0) throw new Error(`a value a read handed out changed to ${show(value)}, was ${show(was)}`);
      value.fill(0xee);
    }
    this.handed = [];
  }

  value(spec: ValueSpec): Uint8Array {
    const head = utf(`v${this.nextValue++}.`);
    const out = new Uint8Array(spec.size);
    out.fill(spec.fill.charCodeAt(0));
    out.set(head.subarray(0, spec.size));
    return out;
  }
}

/**
 * Small flush runs, so a flush of a few records, or of one large one, spans
 * several L0 runs. No L0 stop: a command can hold compaction, and a flush
 * waiting for it would wait on a command that never comes.
 */
export const SIM_HOST_LIMITS = { flushRunBytes: 8 * 1024, l0StopRuns: Number.POSITIVE_INFINITY };

/** The system under test: one handle, its host, and the files they share. */
export class Sut {
  /** While set, the host's run opens wait: a compaction stalls before its merge. */
  private gate: { readonly opened: Promise<void>; readonly open: () => void } | undefined;
  readonly host = new EngineHost(() => this.hostFs(), SIM_HOST_LIMITS);
  db!: Db;
  /** Appends `changes` announced. The handle is the only writer, so each is one of its own. */
  readonly appended: Extract<ChangeEvent, { kind: "append" }>[] = [];

  constructor(
    readonly name: string,
    private readonly maxWalBytes: number,
    readonly fs: RemovableFs = new MemoryFs(),
  ) {}

  /** The host ingests on its own once the WAL passes `maxWalBytes`, racing every command. */
  get background(): boolean {
    return this.maxWalBytes < 1 << 20;
  }

  async open(): Promise<void> {
    const db = await openHarnessDb({
      name: this.name,
      fs: this.fs,
      ingest: createLocalIngestClient(this.host),
      maxWalBytes: this.maxWalBytes,
      // The host hears of every append as it lands, so a replay ingests at the same command.
      rowPostMs: 0,
    });
    db.changes((e) => {
      if (e.kind === "append") this.appended.push(e);
    });
    this.db = db;
  }

  /**
   * The host's view of the files. Compaction is the only host work that
   * opens a run, so the gate stalls a merge and nothing else, and flushes
   * keep landing L0 runs in front of its inputs.
   */
  private hostFs(): AsyncFs {
    const fs = this.fs;
    return {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: async (path) => {
        if (path.endsWith(".sst")) await this.gate?.opened;
        return fs.open(path);
      },
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
  }

  hold(): void {
    if (this.gate) return;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    this.gate = { opened, open };
  }

  release(): void {
    this.gate?.open();
    this.gate = undefined;
  }

  /** Wait for compaction in flight, and run one more pass. Folds no WAL. */
  settle(): Promise<unknown> {
    this.release();
    return compactHost(this.host, this.name);
  }

  async dispose(): Promise<void> {
    await this.db.close();
    await this.settle().catch(() => undefined);
    await deleteWal(this.name);
  }
}

type Cmd = fc.AsyncCommand<Model, Sut, false>;

// --- Generators. Few keys, shared prefixes, and deletes, so writes collide.

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

const LONG = 8 * 1024;
const KEYS: readonly Uint8Array[] = [
  new Uint8Array(0),
  utf("a"),
  utf("a\u0000"),
  utf("ab"),
  utf("abc"),
  utf("abd"),
  utf("b"),
  utf("ba"),
  utf("k/0001"),
  utf("k/0002"),
  utf("k/0010"),
  utf("k/0100"),
  new Uint8Array([0xff]),
  new Uint8Array([0xff, 0xff]),
  utf("L".repeat(LONG)),
  utf(`${"L".repeat(LONG - 1)}M`),
];
const keyArb = fc.nat({ max: KEYS.length - 1 });

type ValueSpec = { readonly size: number; readonly fill: string };
const valueArb: fc.Arbitrary<ValueSpec> = fc.record({
  size: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 24 }) },
    // Around the bounds of the pooled copies (65 bytes to 1 KiB).
    { weight: 3, arbitrary: fc.constantFrom(64, 65, 1024, 1025) },
    { weight: 2, arbitrary: fc.integer({ min: 65, max: 1024 }) },
    { weight: 2, arbitrary: fc.integer({ min: 3_000, max: 6_000 }) },
    { weight: 1, arbitrary: fc.constant(64 * 1024) },
  ),
  fill: fc.constantFrom("a", "b", "c"),
});

/** A range delete from `start` to `end` (to the end of the keys when absent or not above it), `back` seqs below the head. */
type DeleteRangeSpec = { readonly type: "deleteRange"; readonly start: number; readonly end?: number; readonly back?: number };
type OpSpec =
  | { readonly type: "put"; readonly key: number; readonly value: ValueSpec }
  | { readonly type: "del"; readonly key: number }
  | DeleteRangeSpec;
const deleteRangeArb: fc.Arbitrary<DeleteRangeSpec> = fc.record(
  { type: fc.constant("deleteRange" as const), start: keyArb, end: keyArb, back: fc.integer({ min: -2, max: 6 }) },
  { requiredKeys: ["type", "start"] },
);
const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ type: fc.constant("put" as const), key: keyArb, value: valueArb }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant("del" as const), key: keyArb }) },
  { weight: 1, arbitrary: deleteRangeArb },
);

type RangeSpec = { start?: number; end?: number; limit?: number; offset?: number; contains?: string; reverse?: boolean };
const rangeArb: fc.Arbitrary<RangeSpec> = fc.record(
  {
    start: keyArb,
    end: keyArb,
    limit: fc.integer({ min: 0, max: 4 }),
    offset: fc.integer({ min: 0, max: 3 }),
    contains: fc.constantFrom("a", "b", "v1", "."),
    reverse: fc.boolean(),
  },
  { requiredKeys: [] },
);

function rangeOf(spec: RangeSpec): OracleRange {
  return {
    ...(spec.start !== undefined ? { start: KEYS[spec.start]! } : {}),
    ...(spec.end !== undefined ? { endExclusive: KEYS[spec.end]! } : {}),
    ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
    ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
    ...(spec.contains !== undefined ? { valueContains: [utf(spec.contains)] } : {}),
    ...(spec.reverse ? { reverse: true } : {}),
  };
}

/** `values` is `snap.rangeValues`, `join` is `snap.rangeJoin` to the key `joinKey` picks. */
type ReadSpec =
  | { readonly kind: "get"; readonly key: number }
  | { readonly kind: "getMany"; readonly keys: readonly number[]; readonly decode: boolean }
  | { readonly kind: "range" | "count" | "values" | "join"; readonly range: RangeSpec };
const getManyArb = fc.record({
  kind: fc.constant("getMany" as const),
  keys: fc.array(keyArb, { maxLength: 4 }),
  decode: fc.boolean(),
});
const readArb: fc.Arbitrary<ReadSpec> = fc.oneof(
  fc.record({ kind: fc.constant("get" as const), key: keyArb }),
  getManyArb,
  fc.record({ kind: fc.constantFrom("range" as const, "count" as const, "values" as const, "join" as const), range: rangeArb }),
);

/** The key a `join` read joins an entry to, or none: picked by the value's length. */
function joinKey(entry: { readonly value: Uint8Array }): Uint8Array | undefined {
  return KEYS[entry.value.length % (KEYS.length + 1)];
}

/** What a read command runs mid-read: a write, or host work. */
type Interleave = { readonly kind: "write"; readonly op: OpSpec } | { readonly kind: "ingest" | "flush" | "compact" };
const interleaveArb: fc.Arbitrary<Interleave> = fc.oneof(
  { weight: 3, arbitrary: opArb.map((op) => ({ kind: "write" as const, op })) },
  { weight: 1, arbitrary: fc.constantFrom<Interleave>({ kind: "ingest" }, { kind: "flush" }, { kind: "compact" }) },
);

async function interleave(m: Model, r: Sut, what: Interleave): Promise<void> {
  if (what.kind === "write") {
    const ops = opsOf(m, [what.op]);
    return write(m, r, ops, () => writeOps(r.db, ops));
  }
  if (what.kind === "ingest") {
    r.release();
    await ingest(r.db);
  } else if (what.kind === "flush") await r.host.ingest(r.name);
  else await r.settle();
}

const keyName = (i: number) => show(KEYS[i]!);
function opName(op: OpSpec): string {
  switch (op.type) {
    case "put":
      return `put ${keyName(op.key)} ${op.value.size}${op.value.fill}`;
    case "del":
      return `del ${keyName(op.key)}`;
    case "deleteRange":
      return `deleteRange ${keyName(op.start)}..${op.end === undefined ? "" : keyName(op.end)}${op.back === undefined ? "" : ` through head-${op.back}`}`;
  }
}
const rangeName = (r: RangeSpec) => JSON.stringify(r);
const interleaveName = (what: Interleave) => (what.kind === "write" ? opName(what.op) : what.kind);
function readName(x: ReadSpec): string {
  if (x.kind === "get") return `get ${keyName(x.key)}`;
  if (x.kind === "getMany") return `getMany[${x.keys.map(keyName).join(", ")}]${x.decode ? " decode" : ""}`;
  return `${x.kind} ${rangeName(x.range)}`;
}

// --- Writes.

function opsOf(m: Model, specs: readonly OpSpec[]): OracleOp[] {
  return specs.map((op): OracleOp => {
    switch (op.type) {
      case "put":
        return { type: "put", key: KEYS[op.key]!, value: m.value(op.value) };
      case "del":
        return { type: "del", key: KEYS[op.key]! };
      case "deleteRange": {
        const start = KEYS[op.start]!;
        const end = op.end === undefined ? undefined : KEYS[op.end]!;
        return {
          type: "deleteRange",
          start,
          ...(end && compareBytes(start, end) < 0 ? { endExclusive: end } : {}),
          ...(op.back === undefined ? {} : { through: Math.max(0, m.oracle.head - op.back) }),
        };
      }
    }
  });
}

/** One op through its shortcut, several in one batch. */
function writeOps(db: Db, ops: readonly OracleOp[]): Promise<number> {
  const op = ops.length === 1 ? ops[0]! : undefined;
  if (op?.type === "put") return db.put(op.key, op.value);
  if (op?.type === "del") return db.delete(op.key);
  return db.batch((tx) => applyOps(tx, ops));
}

/**
 * Run a write and check it appended exactly one record at the next seq, or
 * none for no ops, and that its `changes` event carries its ops. Then the
 * caller reuses the values' buffers, which the write copied (README, "Batches").
 */
async function write(m: Model, r: Sut, ops: readonly OracleOp[], run: () => Promise<unknown>): Promise<void> {
  const before = r.appended.length;
  await run();
  const events = r.appended.slice(before);
  if (ops.length === 0) {
    expect(events, "a write with no ops appends nothing").toEqual([]);
    return;
  }
  const seq = m.oracle.head + 1;
  expect(events.map((e) => e.seq), "one append at the next seq").toEqual([seq]);
  expect(events[0]!.ops.map(showOp), "the append event's ops").toEqual(ops.map((op) => showOp(resolved(op, seq))));
  m.reader.acked(m.oracle.append(ops));
  for (const op of ops) if (op.type === "put") op.value.fill(0xdd);
}

/** `op` as its change event reports it: a range delete's `through` below its seq. */
function resolved(op: OracleOp, seq: number): ChangeOp {
  if (op.type !== "deleteRange") return op;
  const { through, ...bounds } = op;
  return { ...bounds, through: Math.min(through ?? Number.MAX_SAFE_INTEGER, seq - 1) };
}

function showOp(op: ChangeOp): string {
  if (op.type === "deleteRange") return `deleteRange ${show(op.start)}..${op.endExclusive ? show(op.endExclusive) : ""} through ${op.through}`;
  return op.type === "put" ? `put ${show(op.key)}=${show(op.value)}(${op.value.length}B)` : `del ${show(op.key)}`;
}

class BatchCmd implements Cmd {
  constructor(private readonly ops: readonly OpSpec[]) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const ops = opsOf(m, this.ops);
    await write(m, r, ops, () => writeOps(r.db, ops));
  }
  toString = () => (this.ops.length === 1 ? opName(this.ops[0]!) : `batch[${this.ops.map(opName).join("; ")}]`);
}

/** Many distinct keys in one batch: memtable chunk splits, multi-block runs. */
class BulkCmd implements Cmd {
  constructor(
    private readonly count: number,
    private readonly step: number,
    private readonly del: boolean,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const ops: OracleOp[] = [];
    for (let i = 0; i < this.count; i++) {
      const key = utf(`n/${String(i * this.step).padStart(5, "0")}`);
      ops.push(this.del ? { type: "del", key } : { type: "put", key, value: m.value({ size: 8, fill: "b" }) });
    }
    await write(m, r, ops, () => r.db.batch((tx) => applyOps(tx, ops)));
  }
  toString = () => `bulk ${this.del ? "del" : "put"} ${this.count} keys step ${this.step}`;
}

type UpdateAction = "keep" | "del" | "put";

/**
 * `update` reads `keys` and writes in one transaction, so it reads the prefix
 * just before its own seq. The body reads the last `late` keys with
 * `tx.read`, writes `more` ops to any key after the ones `actions` picks,
 * and returns a value, or throws: then the update rejects with that error
 * and writes nothing (README, "Read-modify-write").
 */
class UpdateCmd implements Cmd {
  constructor(
    private readonly keys: readonly number[],
    private readonly actions: readonly UpdateAction[],
    private readonly value: ValueSpec,
    private readonly more: readonly OpSpec[],
    private readonly throws: boolean,
    private readonly late: number,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    const keys = this.keys.map((k) => KEYS[k]!);
    const ops: OracleOp[] = [];
    keys.forEach((key, i) => {
      const action = this.actions[i % this.actions.length];
      if (action === "put") ops.push({ type: "put", key, value: m.value(this.value) });
      else if (action === "del") ops.push({ type: "del", key });
    });
    ops.push(...opsOf(m, this.more));
    let seen: readonly (Uint8Array | undefined)[] = [];
    const failure = new Error("the body threw");
    const result = {};
    const first = keys.slice(0, Math.max(keys.length - this.late, 0));
    const rest = keys.slice(first.length);
    const run = () =>
      r.db.update(first, (got, tx) => {
        seen = rest.length ? [...got, ...tx.read(rest)] : got;
        applyOps(tx, ops);
        if (this.throws) throw failure;
        return result;
      });
    if (this.throws) {
      const before = r.appended.length;
      await expect(run(), "update rejects with what its body threw").rejects.toBe(failure);
      expect(r.appended.length, "an update whose body threw appends nothing").toBe(before);
    } else {
      await write(m, r, ops, async () => expect(await run(), "update resolves with what its body returned").toBe(result));
    }
    seen.forEach((v) => m.hand(v));
    const at = ops.length > 0 && !this.throws ? m.oracle.head - 1 : undefined;
    if (at !== undefined) {
      keys.forEach((k, i) => {
        expect(seen[i], `update read ${show(k)} at seq ${at}`).toEqual(m.oracle.valueAt(k, at));
      });
    } else {
      const v = m.reader.view();
      keys.forEach((k, i) => v.get(k, seen[i]));
      v.finish();
    }
  }
  toString = () =>
    `update[${this.keys.map((k, i) => `${keyName(k)}:${this.actions[i % this.actions.length]}`).join(", ")}]` +
    (this.late ? ` late ${this.late}` : "") +
    (this.more.length ? ` then ${this.more.map(opName).join("; ")}` : "") +
    (this.throws ? " throws" : "");
}

// --- Reads.

async function collect(it: AsyncIterable<Entry>): Promise<OracleEntry[]> {
  const out: OracleEntry[] = [];
  for await (const e of it) out.push({ key: e.key, value: e.value });
  return out;
}

class GetCmd implements Cmd {
  constructor(private readonly key: number) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    m.reader.get(KEYS[this.key]!, m.hand(await r.db.get(KEYS[this.key]!)));
  }
  toString = () => `get ${keyName(this.key)}`;
}

/** A read of several keys, so the same writes. With `decode`, a decode that copies the stored bytes. */
type ManyReader = Pick<Db, "getMany">;
async function getMany(m: Model, from: ManyReader, check: ViewCheck, spec: Extract<ReadSpec, { kind: "getMany" }>): Promise<void> {
  const keys = spec.keys.map((k) => KEYS[k]!);
  const got = spec.decode ? await from.getMany(keys, (bytes) => bytes.slice()) : await from.getMany(keys);
  expect(got.length, "getMany returns a value per key").toBe(keys.length);
  keys.forEach((k, i) => check.get(k, m.hand(got[i])));
}

class GetManyCmd implements Cmd {
  constructor(private readonly spec: Extract<ReadSpec, { kind: "getMany" }>) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    const check = m.reader.view();
    await getMany(m, r.db, check, this.spec);
    check.finish();
  }
  toString = () => readName(this.spec);
}

/** A range, with `during` run before entry `at` of it: the scan reads one state, from the first `next()` on. */
class RangeCmd implements Cmd {
  constructor(
    private readonly range: RangeSpec,
    private readonly at: number,
    private readonly during: Interleave | undefined,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    const range = rangeOf(this.range);
    const check = m.reader.view();
    const it = r.db.range(range)[Symbol.asyncIterator]();
    const out: OracleEntry[] = [];
    for (let i = 0; ; i++) {
      if (i === this.at && this.during) await interleave(m, r, this.during);
      const next = await it.next();
      if (next.done) break;
      out.push({ key: next.value.key, value: m.hand(next.value.value) });
    }
    check.range(range, out);
    check.finish();
  }
  toString = () => `range ${rangeName(this.range)}` + (this.during ? ` with ${interleaveName(this.during)} before entry ${this.at}` : "");
}

class CountCmd implements Cmd {
  constructor(private readonly range: RangeSpec) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    const range = rangeOf(this.range);
    m.reader.count(range, await r.db.count(range));
  }
  toString = () => `count ${rangeName(this.range)}`;
}

/** Reads in one view, with `during` run before read `at`: a write acked mid-view or host work, which the view must not see. */
class ViewCmd implements Cmd {
  constructor(
    private readonly reads: readonly ReadSpec[],
    private readonly at: number | undefined,
    private readonly during: Interleave,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.scribble();
    const check = m.reader.view();
    await r.db.view(async (snap) => {
      check.seq(snap.seq);
      for (let i = 0; i <= this.reads.length; i++) {
        if (i === this.at) await interleave(m, r, this.during);
        const read = this.reads[i];
        if (!read) continue;
        if (read.kind === "get") {
          check.get(KEYS[read.key]!, m.hand(await snap.get(KEYS[read.key]!)));
        } else if (read.kind === "getMany") {
          await getMany(m, snap, check, read);
        } else if (read.kind === "count") {
          const range = rangeOf(read.range);
          check.count(range, await snap.count(range));
        } else if (read.kind === "values") {
          const range = rangeOf(read.range);
          const entries = await snap.rangeValues(range, (bytes) => bytes.slice());
          check.range(range, entries.map((e) => ({ key: e.key, value: m.hand(e.value) })));
        } else if (read.kind === "join") {
          const range = rangeOf(read.range);
          const joins = await snap.rangeJoin(range, joinKey);
          check.range(range, joins.map(({ entry }) => ({ key: entry.key, value: m.hand(entry.value) })));
          for (const { entry, joined } of joins) {
            const key = joinKey(entry);
            if (key) check.get(key, m.hand(joined));
            else expect(joined, "rangeJoin joins nothing when keyOf returns undefined").toBeUndefined();
          }
        } else {
          const range = rangeOf(read.range);
          check.range(range, (await collect(snap.range(range))).map((e) => ({ key: e.key, value: m.hand(e.value) })));
        }
      }
    });
    check.finish();
  }
  toString = () =>
    `view[${this.reads.map(readName).join("; ")}]` + (this.at !== undefined ? ` with ${interleaveName(this.during)} before read ${this.at}` : "");
}

// --- Coordination and lifecycle.

class SyncCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const head = m.oracle.head;
    await r.db.sync();
    m.reader.synced(head);
  }
  toString = () => "sync";
}

/** `ingest(db)`: flush the WAL to L0 and wait for the compaction it starts. */
class IngestCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    r.release();
    await ingest(r.db);
  }
  toString = () => "ingest";
}

/** Stall the next compaction before its merge, until a command that waits for compaction. */
class HoldCompactionCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    r.hold();
  }
  toString = () => "hold compaction";
}

/** Flush and return while compaction runs in the background, racing later commands. */
class FlushCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    await r.host.ingest(r.name);
  }
  toString = () => "flush (compaction in background)";
}

/** Run a compaction pass without flushing. */
class CompactCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    await r.settle();
  }
  toString = () => "compact";
}

/**
 * Every call on a handle that `close()` or `destroyDb` closed fails with
 * `ClosedError` (README, "Errors"), whatever the handle held.
 */
async function expectClosed(db: Db): Promise<void> {
  const key = KEYS[1]!;
  const calls: Record<string, () => unknown> = {
    get: () => db.get(key),
    getMany: () => db.getMany([key]),
    put: () => db.put(key, key),
    delete: () => db.delete(key),
    batch: () => db.batch(() => {}),
    update: () => db.update([key], () => undefined),
    range: () => db.range()[Symbol.asyncIterator]().next(),
    count: () => db.count(),
    view: () => db.view(() => undefined),
    changes: () => db.changes(() => {}),
    onStorageFull: () => db.onStorageFull(async () => {}),
    sync: () => db.sync(),
    dangerousDestroy: () => db.dangerousDestroy(),
  };
  for (const [name, call] of Object.entries(calls)) {
    let failed: unknown;
    try {
      await call();
    } catch (err) {
      failed = err;
    }
    expect(failed, `${name} on a closed handle`).toBeInstanceOf(ClosedError);
  }
}

/** Close the handle and open a new one. No crash: every acked write must be there. */
class ReopenCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    await r.db.close();
    await expectClosed(r.db);
    await r.open();
    m.reader.synced(m.oracle.head);
  }
  toString = () => "reopen";
}

/**
 * `destroyDb`, then open again. It takes one seq, as a range delete of every
 * key: the next open starts one past its head. A held compaction is let go
 * first, since the removal waits for the compaction lock.
 */
class RemoveCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    r.release();
    await destroyHarnessDb({ name: r.name, fs: r.fs, ingest: createLocalIngestClient(r.host) });
    await expectClosed(r.db);
    m.oracle.append([{ type: "deleteRange", start: new Uint8Array(0) }]);
    await r.open();
    m.reader.synced(m.oracle.head);
  }
  toString = () => "remove";
}

/**
 * Quiesce, then run the integrity check and compare the on-disk state with
 * the oracle. With background ingest on, only closing the handle stops the
 * host from starting another one, so the check closes and reopens. Once
 * compaction has nothing left to do, every range delete has retired.
 */
class CheckCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    if (r.background) await r.db.close();
    let generation: number | undefined;
    for (let pass = 0; ; pass++) {
      await r.settle();
      const now = (await walMeta(r.name)).generation;
      if (now === generation) break;
      expect(pass, "compaction settles").toBeLessThan(50);
      generation = now;
    }
    await expectHealthy(m, r, r.background);
    if (generation) expect((await loadGeneration(r.fs, generation))!.marks, "marks left once compaction settles").toEqual([]);
    if (r.background) {
      await r.open();
      m.reader.synced(m.oracle.head);
    }
  }
  toString = () => "check";
}

/**
 * With `closed`, no handle holds a run open, so after `settle` reclaim has
 * left no orphan. An open handle keeps retired runs until it installs the
 * new generation, which arrives over BroadcastChannel.
 */
export async function expectHealthy(m: Model, r: Sut, closed: boolean): Promise<void> {
  const report = await checkDatabase(r.fs, r.name);
  expect(report.problems, "checkDatabase problems").toEqual([]);
  if (closed) expect(report.orphans, "orphan runs").toEqual([]);
  expect(report.staleManifests, "stale manifests").toEqual([]);
  expect(report.head, "WAL head").toBe(m.oracle.head);
  expectEntries(report.state, m.oracle.stateAt(), "on-disk state");
}

export function expectEntries(got: readonly OracleEntry[], want: readonly OracleEntry[], label: string): void {
  const fmt = (es: readonly OracleEntry[]) => es.map((e) => `${show(e.key)}=${show(e.value)}`);
  expect(fmt(got), `${label}`).toEqual(fmt(want));
  for (let i = 0; i < want.length; i++) {
    expect(got[i]!.value, `${label}: value of ${show(want[i]!.key)}`).toEqual(want[i]!.value);
  }
}

/** `replayPath` is the replayPath a failure prints in a comment after its counterexample. */
export const commandsArb = (replayPath?: string, maxCommands = 80) => fc.commands<Model, Sut, false>(
  [
    fc.array(opArb, { minLength: 1, maxLength: 1 }).map((ops) => new BatchCmd(ops)),
    fc.array(opArb, { minLength: 1, maxLength: 1 }).map((ops) => new BatchCmd(ops)),
    fc.array(opArb, { minLength: 0, maxLength: 6 }).map((ops) => new BatchCmd(ops)),
    fc
      .tuple(fc.integer({ min: 100, max: 1_200 }), fc.integer({ min: 1, max: 3 }), fc.boolean())
      .map(([n, step, del]) => new BulkCmd(n, step, del)),
    fc
      .tuple(
        fc.array(keyArb, { minLength: 1, maxLength: 3 }),
        fc.array(fc.constantFrom<UpdateAction>("keep", "del", "put"), { minLength: 1, maxLength: 3 }),
        valueArb,
        fc.array(opArb, { maxLength: 2 }),
        fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
        fc.nat({ max: 3 }),
      )
      .map(([keys, actions, value, more, throws, late]) => new UpdateCmd(keys, actions, value, more, throws, late)),
    keyArb.map((k) => new GetCmd(k)),
    keyArb.map((k) => new GetCmd(k)),
    getManyArb.map((spec) => new GetManyCmd(spec)),
    fc
      .tuple(rangeArb, fc.nat({ max: 3 }), fc.option(interleaveArb, { nil: undefined, freq: 2 }))
      .map(([range, at, during]) => new RangeCmd(range, at, during)),
    rangeArb.map((range) => new CountCmd(range)),
    fc
      .tuple(fc.array(readArb, { minLength: 1, maxLength: 4 }), fc.option(fc.nat({ max: 4 }), { nil: undefined }), interleaveArb)
      .map(([reads, at, during]) => new ViewCmd(reads, at, during)),
    fc.constant(new SyncCmd()),
    fc.constant(new IngestCmd()),
    fc.constant(new IngestCmd()),
    fc.constant(new FlushCmd()),
    fc.constant(new FlushCmd()),
    fc.constant(new HoldCompactionCmd()),
    fc.constant(new CompactCmd()),
    fc.constant(new ReopenCmd()),
    fc.constant(new RemoveCmd()),
    fc.constant(new CheckCmd()),
  ],
  { maxCommands, size: "max", ...(replayPath ? { replayPath } : {}) },
);
