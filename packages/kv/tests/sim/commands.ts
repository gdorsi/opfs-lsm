import fc from "fast-check";
import { expect } from "vitest";
import type { Db } from "../../src/index.js";
import {
  openHarnessDb,
  ingest,
  type AsyncFs,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../../src/testing.js";
import { checkDatabase, deleteWal, walMeta } from "./check-database.js";
import { loadGeneration } from "../../src/store/generation.js";
import { compareBytes } from "../../src/bytes.js";
import { applyOps, Oracle, Reader, show, type OracleEntry, type OracleOp, type OracleRange } from "./oracle.js";

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
  /** Seqs `changes` announced. The handle is the only writer, so each is one of its own appends. */
  readonly appended: number[] = [];

  constructor(
    readonly name: string,
    private readonly maxWalBytes: number,
    readonly fs: AsyncFs = new MemoryFs(),
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
      if (e.kind === "append") this.appended.push(e.seq);
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
    return this.host.compact(this.name);
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

type RangeSpec = { start?: number; end?: number; limit?: number; contains?: string; reverse?: boolean };
const rangeArb: fc.Arbitrary<RangeSpec> = fc.record(
  {
    start: keyArb,
    end: keyArb,
    limit: fc.integer({ min: 0, max: 4 }),
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
    ...(spec.contains !== undefined ? { valueContains: [utf(spec.contains)] } : {}),
    ...(spec.reverse ? { reverse: true } : {}),
  };
}

type ReadSpec = { readonly kind: "get"; readonly key: number } | { readonly kind: "range"; readonly range: RangeSpec };
const readArb: fc.Arbitrary<ReadSpec> = fc.oneof(
  fc.record({ kind: fc.constant("get" as const), key: keyArb }),
  fc.record({ kind: fc.constant("range" as const), range: rangeArb }),
);

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

/** Run a write and check it appended exactly one record at the next seq, or none for no ops. */
async function write(m: Model, r: Sut, ops: readonly OracleOp[], run: () => Promise<unknown>): Promise<void> {
  const before = r.appended.length;
  await run();
  const seqs = r.appended.slice(before);
  if (ops.length === 0) {
    expect(seqs, "a write with no ops appends nothing").toEqual([]);
    return;
  }
  expect(seqs, "one append at the next seq").toEqual([m.oracle.head + 1]);
  m.reader.acked(m.oracle.append(ops));
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

/** `update` reads `keys` and writes in one transaction, so it reads the prefix just before its own seq. */
class UpdateCmd implements Cmd {
  constructor(
    private readonly keys: readonly number[],
    private readonly actions: readonly UpdateAction[],
    private readonly value: ValueSpec,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const keys = this.keys.map((k) => KEYS[k]!);
    const ops: OracleOp[] = [];
    keys.forEach((key, i) => {
      const action = this.actions[i % this.actions.length];
      if (action === "put") ops.push({ type: "put", key, value: m.value(this.value) });
      else if (action === "del") ops.push({ type: "del", key });
    });
    let seen: readonly (Uint8Array | undefined)[] = [];
    await write(m, r, ops, () =>
      r.db.update(keys, (got, tx) => {
        seen = got.map((v) => (v ? new Uint8Array(v) : undefined));
        applyOps(tx, ops);
      }),
    );
    const at = ops.length > 0 ? m.oracle.head - 1 : undefined;
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
  toString = () => `update[${this.keys.map((k, i) => `${keyName(k)}:${this.actions[i % this.actions.length]}`).join(", ")}]`;
}

// --- Reads.

class GetCmd implements Cmd {
  constructor(private readonly key: number) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    m.reader.get(KEYS[this.key]!, await r.db.get(KEYS[this.key]!));
  }
  toString = () => `get ${keyName(this.key)}`;
}

class RangeCmd implements Cmd {
  constructor(private readonly range: RangeSpec) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const range = rangeOf(this.range);
    m.reader.range(range, await r.db.range(range));
  }
  toString = () => `range ${rangeName(this.range)}`;
}

/** Reads in one view, with an optional write acked mid-view that the view must not see. */
class ViewCmd implements Cmd {
  constructor(
    private readonly reads: readonly ReadSpec[],
    private readonly writeAt: number | undefined,
    private readonly op: OpSpec,
  ) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const check = m.reader.view();
    await r.db.view(async (snap) => {
      for (let i = 0; i <= this.reads.length; i++) {
        if (i === this.writeAt) {
          const ops = opsOf(m, [this.op]);
          await write(m, r, ops, () => writeOps(r.db, ops));
        }
        const read = this.reads[i];
        if (!read) continue;
        if (read.kind === "get") {
          check.get(KEYS[read.key]!, await snap.get(KEYS[read.key]!));
        } else {
          const range = rangeOf(read.range);
          check.range(range, await snap.range(range));
        }
      }
    });
    check.finish();
  }
  toString = () =>
    `view[${this.reads.map((x) => (x.kind === "get" ? `get ${keyName(x.key)}` : `range ${rangeName(x.range)}`)).join("; ")}]` +
    (this.writeAt !== undefined ? ` with ${opName(this.op)} before read ${this.writeAt}` : "");
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

/** Close the handle and open a new one. No crash: every acked write must be there. */
class ReopenCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    await r.db.close();
    await r.open();
    m.reader.synced(m.oracle.head);
  }
  toString = () => "reopen";
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
      )
      .map(([keys, actions, value]) => new UpdateCmd(keys, actions, value)),
    keyArb.map((k) => new GetCmd(k)),
    keyArb.map((k) => new GetCmd(k)),
    rangeArb.map((range) => new RangeCmd(range)),
    fc
      .tuple(fc.array(readArb, { minLength: 1, maxLength: 4 }), fc.option(fc.nat({ max: 4 }), { nil: undefined }), opArb)
      .map(([reads, at, op]) => new ViewCmd(reads, at, op)),
    fc.constant(new SyncCmd()),
    fc.constant(new IngestCmd()),
    fc.constant(new IngestCmd()),
    fc.constant(new FlushCmd()),
    fc.constant(new FlushCmd()),
    fc.constant(new HoldCompactionCmd()),
    fc.constant(new CompactCmd()),
    fc.constant(new ReopenCmd()),
    fc.constant(new CheckCmd()),
  ],
  { maxCommands, size: "max", ...(replayPath ? { replayPath } : {}) },
);
