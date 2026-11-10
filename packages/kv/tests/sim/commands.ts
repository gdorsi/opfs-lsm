import fc from "fast-check";
import { expect } from "vitest";
import { dbInternals } from "../../src/db.js";
import type { AsyncFs, Db, Entry } from "../../src/index.js";
import { MemoryFs } from "../../src/index.js";
import type { SegmentStore } from "../../src/log/queue-writer.js";
import { Host, openHarnessDb, type HostLimits } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";
import { Oracle, Reader, show, type OracleEntry, type OracleOp, type OracleRange } from "./oracle.js";

/**
 * fast-check commands for one `Db` handle over MemoryFs and a SharedWorker
 * `Host`, checked against the oracle. See docs/research/corruption-hardening-test-suite.md,
 * technique 1. With one page, the ingest order is its ack order, so every
 * read is `fold(log[1..p])` of the acked log.
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

/** The system under test: one handle, its host, and the files they share. */
export class Sut {
  /** While set, the host's whole-run reads wait: a compaction stalls before its merge. */
  private gate: { readonly opened: Promise<void>; readonly open: () => void } | undefined;
  readonly host: Host;
  readonly segments: SegmentStore;
  db!: Db;
  /** Called at each acked write, after the oracle took it. */
  onAck: (() => void) | undefined;
  /** How many handles opened so far: each one writes its own log. */
  opens = 0;

  constructor(
    readonly name: string,
    limits: Partial<HostLimits>,
    readonly fs: AsyncFs = new MemoryFs(),
    segments?: SegmentStore,
  ) {
    this.host = new Host(() => this.hostFs(), { maxLatencyMs: 1e9, ...limits });
    this.segments = segments ?? (fs as MemoryFs).segments;
  }

  async open(): Promise<void> {
    this.db = await openHarnessDb({ name: this.name, fs: this.fs, segments: this.segments, host: this.host });
    this.opens++;
  }

  /** Records this handle appended. */
  appended(): number {
    return dbInternals(this.db)!.appended().records;
  }

  /**
   * The host's view of the files. Only compaction reads whole runs through
   * `read` (tabs `open` them, and recovery reads one byte), so the gate
   * stalls a merge and nothing else, and ingest keeps landing L0 runs in
   * front of its inputs.
   */
  private hostFs(): AsyncFs {
    const fs = this.fs;
    return {
      read: async (path, offset, length) => {
        if (path.endsWith(".sst") && length > 1) await this.gate?.opened;
        return fs.read(path, offset, length);
      },
      open: (path) => fs.open(path),
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

  /**
   * Close the handle, then ingest every log and compact on a new one, twice:
   * the second handle's compaction pass reclaims the runs the first held.
   * Leaves the second handle open.
   */
  async quiet(): Promise<void> {
    this.release();
    await this.db.close();
    await this.open();
    await this.db.ingest();
    await this.db.close();
    await this.open();
    await this.db.ingest();
  }

  async dispose(): Promise<void> {
    this.release();
    await this.db.close();
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

type OpSpec = { readonly type: "put"; readonly key: number; readonly value: ValueSpec } | { readonly type: "del"; readonly key: number };
const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constant("put" as const), key: keyArb, value: valueArb }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("del" as const), key: keyArb }) },
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
const opName = (op: OpSpec) =>
  op.type === "put" ? `put ${keyName(op.key)} ${op.value.size}${op.value.fill}` : `del ${keyName(op.key)}`;
const rangeName = (r: RangeSpec) => JSON.stringify(r);

// --- Writes.

function opsOf(m: Model, specs: readonly OpSpec[]): OracleOp[] {
  return specs.map((op) =>
    op.type === "put"
      ? { type: "put", key: KEYS[op.key]!, value: m.value(op.value) }
      : { type: "del", key: KEYS[op.key]! },
  );
}

/** Run a write and check it appended exactly one record, or none for no ops. */
async function write(m: Model, r: Sut, ops: readonly OracleOp[], run: () => Promise<unknown>): Promise<void> {
  const before = r.appended();
  await run();
  const appended = r.appended() - before;
  if (ops.length === 0) {
    expect(appended, "a write with no ops appends nothing").toBe(0);
    return;
  }
  expect(appended, "one record").toBe(1);
  m.reader.acked(m.oracle.append(ops));
  r.onAck?.();
}

class BatchCmd implements Cmd {
  constructor(private readonly ops: readonly OpSpec[]) {}
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    const ops = opsOf(m, this.ops);
    await write(m, r, ops, () => {
      if (ops.length === 1) {
        const op = ops[0]!;
        return op.type === "put" ? r.db.put(op.key, op.value) : r.db.delete(op.key);
      }
      return r.db.batch((tx) => {
        for (const op of ops) {
          if (op.type === "put") tx.put(op.key, op.value);
          else tx.delete(op.key);
        }
      });
    });
  }
  toString = () => (this.ops.length === 1 ? opName(this.ops[0]!) : `batch[${this.ops.map(opName).join("; ")}]`);
}

/** Many distinct keys in one batch: multi-block runs. */
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
    await write(m, r, ops, () =>
      r.db.batch((tx) => {
        for (const op of ops) {
          if (op.type === "put") tx.put(op.key, op.value);
          else tx.delete(op.key);
        }
      }),
    );
  }
  toString = () => `bulk ${this.del ? "del" : "put"} ${this.count} keys step ${this.step}`;
}

type UpdateAction = "keep" | "del" | "put";

/** With one page, nothing lands between `update`'s read and its append: it reads the log just before its own record. */
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
        for (const op of ops) {
          if (op.type === "put") tx.put(op.key, op.value);
          else tx.delete(op.key);
        }
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

async function collect(it: AsyncIterable<Entry>): Promise<OracleEntry[]> {
  const out: OracleEntry[] = [];
  for await (const e of it) out.push({ key: e.key, value: e.value });
  return out;
}

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
    m.reader.range(range, await collect(r.db.range(range)));
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
          const op = ops[0]!;
          await write(m, r, ops, () => (op.type === "put" ? r.db.put(op.key, op.value) : r.db.delete(op.key)));
        }
        const read = this.reads[i];
        if (!read) continue;
        if (read.kind === "get") {
          check.get(KEYS[read.key]!, await snap.get(KEYS[read.key]!));
        } else {
          const range = rangeOf(read.range);
          check.range(range, await collect(snap.range(range)));
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
    // A sync's ingest round waits for a compaction pass while L0 is full.
    r.release();
    await r.db.sync();
    m.reader.synced(head);
  }
  toString = () => "sync";
}

/** `db.ingest()`: flush, ingest everything flushed, and compact until a pass installs nothing. */
class IngestCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    r.release();
    await r.db.ingest();
  }
  toString = () => "ingest";
}

/** Stall the next compaction before its merge, until a command that may wait for one: an open, sync, ingest or check. */
class HoldCompactionCmd implements Cmd {
  check = () => true;
  async run(_m: Model, r: Sut): Promise<void> {
    r.hold();
  }
  toString = () => "hold compaction";
}

/** Close the handle and open a new one. No crash: every acked write must be there. */
class ReopenCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    r.release();
    await r.db.close();
    await r.open();
    m.reader.synced(m.oracle.head);
  }
  toString = () => "reopen";
}

/** Quiesce, then run the integrity check and compare the on-disk state with the oracle. */
class CheckCmd implements Cmd {
  check = () => true;
  async run(m: Model, r: Sut): Promise<void> {
    await r.quiet();
    await expectHealthy(m, r);
    m.reader.synced(m.oracle.head);
  }
  toString = () => "check";
}

/** After `Sut.quiet`: every acked record is in the runs, and nothing is left over. */
export async function expectHealthy(m: Model, r: Sut): Promise<void> {
  const report = await checkDatabase(r.fs);
  expect(report.problems, "checkDatabase problems").toEqual([]);
  expect(report.orphans, "orphan runs").toEqual([]);
  expect(report.staleManifests, "stale manifests").toEqual([]);
  expect(report.pending, "records not ingested").toBe(0);
  expect(report.through, "ingested records").toBe(m.oracle.head);
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
    fc.constant(new SyncCmd()),
    fc.constant(new HoldCompactionCmd()),
    fc.constant(new ReopenCmd()),
    fc.constant(new CheckCmd()),
  ],
  { maxCommands, size: "max", ...(replayPath ? { replayPath } : {}) },
);
