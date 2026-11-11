import { AsyncLocalStorage } from "node:async_hooks";
import fc from "fast-check";
import { expect } from "vitest";
import type { Db, Entry } from "../../src/index.js";
import { IdBWal } from "../../src/idb/wal.js";
import {
  openHarnessDb,
  ingest,
  type AsyncFs,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../../src/testing.js";
import { checkDatabase, deleteWal } from "./check-database.js";
import { expectEntries, SIM_HOST_LIMITS } from "./commands.js";
import { checkHistory, History, type NewOp, type OpOf, type ViewRead } from "./history.js";
import { show, type OracleEntry, type OracleOp, type OracleRange } from "./oracle.js";

/**
 * Several `Db` handles (stand-ins for tabs) over one `EngineHost`, one
 * MemoryFs and one fake-indexeddb, driven by `fc.commands` and an
 * `fc.scheduler`. See docs/research/corruption-hardening-test-suite.md,
 * techniques 1 and 5.
 *
 * Commands start ops and return at once (`&` in a command's name), or wait
 * for the op, so ops of different handles overlap. The harness parks every
 * await point it owns as a scheduler task:
 * - BroadcastChannel delivery (a fake channel, FIFO per sender and
 *   receiver as the platform promises, and droppable);
 * - every AsyncFs call of the tabs and of the host except page reads, so a
 *   tab's run open races the host's reclaim and a compaction's merge races
 *   flushes;
 * - a pause between the reads of a `view` and inside a `range`.
 * Parked tasks run only when a `step` command releases them or a waiting
 * command is stuck on them, one at a time, in the order the scheduler
 * picks, so fast-check shrinks the interleaving with the commands.
 * IndexedDB transactions are not parked: between releases the harness lets
 * fake-indexeddb run, so a parked task stays parked while other handles
 * commit. `fc.scheduledModelRun` is not used: it runs each command as a
 * scheduler task and releases nothing else until the command ends, which
 * deadlocks a command that waits for its op.
 *
 * `KV_SIM_TRACE=1` prints every parked task and started op.
 *
 * Every op goes into a `History`. Every WAL commit is recorded with its seq
 * and the op that wrote it (a wrapper on `IdBWal`'s two append methods), so
 * the history check is seq-exact.
 */

// --- Harness seams: commit recorder and BroadcastChannel. Installed once per test file.

const currentOp = new AsyncLocalStorage<number>();
let world: World | undefined;

type Restore = () => void;

export function installSeams(): Restore {
  const proto = IdBWal.prototype;
  const append = proto.append;
  const appendAfter = proto.appendAfter;
  proto.append = async function (this: IdBWal, ops) {
    const op = currentOp.getStore();
    const seq = await append.call(this, ops);
    if (seq !== undefined) world?.history.commit(op, ops, seq);
    return seq;
  };
  proto.appendAfter = async function (this: IdBWal, since: number, decide: Parameters<typeof appendAfter>[1]) {
    const op = currentOp.getStore();
    const out = await appendAfter.call(this, since, decide);
    if (out?.seq !== undefined) world?.history.commit(op, out.ops, out.seq);
    return out;
  } as typeof appendAfter;
  // Node runs a queued Web Lock callback in the async context of whoever
  // released the lock, so a commit inside it would be credited to that op.
  // Browsers have no such context; run the callback in the requester's.
  const locks = navigator.locks;
  const request = locks.request;
  locks.request = function (this: LockManager, name: string, ...rest: unknown[]) {
    const callback = rest.pop() as LockGrantedCallback<unknown>;
    const inRequester = AsyncLocalStorage.snapshot();
    return (request as (...args: unknown[]) => Promise<unknown>).call(this, name, ...rest, (lock: Lock | null) =>
      inRequester(() => callback(lock)),
    );
  } as typeof locks.request;
  const g = globalThis as { BroadcastChannel?: unknown };
  const realChannel = g.BroadcastChannel;
  g.BroadcastChannel = SimChannel;
  return () => {
    proto.append = append;
    proto.appendAfter = appendAfter;
    locks.request = request;
    g.BroadcastChannel = realChannel;
  };
}

type Listener = (ev: { data: unknown }) => void;
const channels = new Map<string, Set<SimChannel>>();

/** In-process BroadcastChannel whose deliveries the world schedules. */
class SimChannel {
  onmessage: Listener | null = null;
  private readonly listeners = new Set<Listener>();
  private closed = false;
  /** Per receiver, the tail of this sender's deliveries, so each pair stays FIFO. */
  private readonly queues = new Map<SimChannel, Promise<void>>();

  constructor(readonly name: string) {
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException("channel is closed", "InvalidStateError");
    for (const to of channels.get(this.name) ?? []) {
      if (to === this) continue;
      const copy = structuredClone(data);
      const prev = this.queues.get(to) ?? Promise.resolve();
      const next = prev
        .then(() => world?.yield(`bus ${describeMessage(copy)} -> ${to.owner}`))
        .then(() => {
          if (world && world.dropNext > 0) {
            world.dropNext--;
            return;
          }
          to.dispatch(copy);
        });
      this.queues.set(to, next);
    }
  }

  /** Who listens, for the scheduler report: tabs subscribe while they open. */
  owner = "host";

  addEventListener(_type: "message", fn: Listener): void {
    if (world?.opening) this.owner = world.opening;
    this.listeners.add(fn);
  }

  removeEventListener(_type: "message", fn: Listener): void {
    this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    channels.get(this.name)?.delete(this);
  }

  private dispatch(data: unknown): void {
    if (this.closed) return;
    const ev = { data };
    this.onmessage?.(ev);
    for (const fn of this.listeners) fn(ev);
  }
}

function describeMessage(data: unknown): string {
  const m = data as { kind?: string; seq?: number } | null;
  return `${m?.kind ?? "?"}${m?.seq !== undefined ? ` seq ${m.seq}` : ""}`;
}

// --- The system under test.

type Session = { readonly id: number; readonly db: Db };

class World {
  readonly history = new History();
  readonly fs = new MemoryFs();
  readonly host = new EngineHost(() => this.wrapFs("host"), SIM_HOST_LIMITS);
  readonly slots: (Session | undefined)[];
  private readonly inflight = new Set<Promise<void>>();
  /** Host-side failures (flush, compaction) that no op reports. */
  readonly hostErrors: unknown[] = [];
  /** After the commands: stop scheduling and let everything run. */
  free = false;
  private readonly gates = new Map<string, { readonly opened: Promise<void>; readonly open: () => void }>();
  /** The session opening now, so its channel can be named. */
  opening: string | undefined;
  /** Drop this many upcoming bus deliveries. */
  dropNext = 0;
  private nextValue = 1;

  constructor(
    readonly name: string,
    private readonly s: fc.Scheduler,
    readonly maxWalBytes: number,
    slots: number,
  ) {
    this.slots = Array.from({ length: slots }, () => undefined);
  }

  /** A point where the scheduler decides what runs next. */
  yield(label: string): Promise<void> {
    if (this.free) return Promise.resolve();
    trace(`[park] ${label}`);
    return this.s.schedule(Promise.resolve(), label);
  }

  /** Wait for `p`, releasing scheduled tasks in the scheduler's order meanwhile. */
  async settle<T>(p: Promise<T>): Promise<T> {
    if (this.free) return p;
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true),
    );
    // Let IndexedDB run first, so a held task stays held while other
    // handles' transactions commit. Release one task only when stuck.
    for (let idle = 0; !done; ) {
      await pump();
      if (done) break;
      if (this.s.count() > 0) {
        idle = 0;
        await this.s.waitOne();
      } else if (this.gates.size > 0) {
        idle = 0;
        this.openGates();
      } else if (++idle > 1000) {
        throw new Error("harness: an awaited op is stuck with no task to release");
      }
    }
    return p;
  }

  /** Release up to `n` scheduled tasks in the scheduler's order, letting IndexedDB run before each. */
  async step(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await pump();
      if (this.s.count() === 0) return;
      await this.s.waitOne();
    }
  }

  /**
   * Hold `who`'s run opens until a waiting command gets stuck on them. A
   * tab that has read a manifest but not opened its runs is the window in
   * which the host can reclaim them (the generation retry loop in db.ts).
   */
  hold(who: string): void {
    if (this.gates.has(who)) return;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    this.gates.set(who, { opened, open });
  }

  private openGates(): void {
    for (const gate of this.gates.values()) gate.open();
    this.gates.clear();
  }

  /** A fresh value: unique, so a read maps back to the write. */
  value(spec: ValueSpec): Uint8Array {
    const head = utf(`v${this.nextValue++}.`);
    const out = new Uint8Array(spec.size);
    out.fill(spec.fill.charCodeAt(0));
    out.set(head.subarray(0, spec.size));
    return out;
  }

  uniq(): string {
    return `u${this.nextValue++}`;
  }

  private wrapFs(who: string): AsyncFs {
    const fs = this.fs;
    return {
      read: async (path, offset, length) => {
        await this.yield(`${who} read ${path}`);
        return fs.read(path, offset, length);
      },
      open: async (path) => {
        await this.gates.get(who)?.opened;
        await this.yield(`${who} open ${path}`);
        return fs.open(path);
      },
      list: async (dir) => {
        await this.yield(`${who} list ${dir}`);
        return fs.list(dir);
      },
      remove: async (path) => {
        await this.yield(`${who} remove ${path}`);
        return fs.remove(path);
      },
      removeUnlessOpen: async (path) => {
        await this.yield(`${who} remove ${path}`);
        return fs.removeUnlessOpen(path);
      },
      create: async (path) => {
        await this.yield(`${who} create ${path}`);
        return fs.create(path);
      },
    };
  }

  async open(slot: number): Promise<void> {
    const session = this.history.newSession();
    const op = this.history.invoke({ kind: "open", session });
    this.opening = `s${session}`;
    try {
      const db = await this.settle(openHarnessDb({
        name: this.name,
        fs: this.wrapFs(`s${session}`),
        ingest: createLocalIngestClient(this.host),
        maxWalBytes: this.maxWalBytes,
      }));
      this.slots[slot] = { id: session, db };
      this.history.respond(op);
    } catch (err) {
      this.history.respond(op, err);
    } finally {
      this.opening = undefined;
    }
  }

  /** Close without waiting for the slot's ops in flight. */
  async close(slot: number): Promise<void> {
    const s = this.slots[slot]!;
    this.slots[slot] = undefined;
    const op = this.history.invoke({ kind: "close", session: s.id });
    await this.settle(s.db.close()).then(
      () => this.history.respond(op),
      (err: unknown) => this.history.respond(op, err),
    );
  }

  /** Start an op on `slot` and record it. Waits for it only with `wait`. */
  async start<K extends NewOp["kind"]>(
    slot: number,
    kind: K,
    fields: Omit<Extract<NewOp, { kind: K }>, "kind" | "session">,
    body: (db: Db, op: OpOf<K>) => Promise<void>,
    wait: boolean,
  ): Promise<void> {
    const s = this.slots[slot]!;
    const op = this.history.invoke({ ...fields, kind, session: s.id } as NewOp) as OpOf<K>;
    trace(`[op] #${op.id} s${s.id} ${op.kind}`);
    const p = currentOp
      .run(op.id, () => body(s.db, op))
      .then(
        () => this.history.respond(op),
        (err: unknown) => this.history.respond(op, err),
      );
    this.track(p);
    if (wait) await this.settle(p);
  }

  /** Host-side work that is not an op of any handle. */
  async hostWork(run: () => Promise<unknown>, wait: boolean): Promise<void> {
    const p = run().then(
      () => undefined,
      (err: unknown) => {
        this.hostErrors.push(err);
      },
    );
    this.track(p);
    if (wait) await this.settle(p);
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Stop scheduling, let every op and delivery finish, close every handle. */
  async quiesce(): Promise<void> {
    this.free = true;
    this.openGates();
    await this.s.waitAll();
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]) await this.close(i);
  }

  async dispose(): Promise<void> {
    this.free = true;
    this.openGates();
    // A failed run leaves tasks the scheduler never released.
    await this.s.waitAll().catch(() => undefined);
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i]) await this.close(i).catch(() => undefined);
    await this.host.ingest(this.name, 0, true).catch(() => undefined);
    await deleteWal(this.name);
    world = undefined;
  }
}

function trace(line: string): void {
  if (process.env.KV_SIM_TRACE) console.log(line);
}

/** A few macrotask turns: enough for fake-indexeddb to move every open transaction on. */
async function pump(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

// --- Generators: few keys, so the handles collide.

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

const KEYS: readonly Uint8Array[] = [
  new Uint8Array(0),
  utf("a"),
  utf("ab"),
  utf("abc"),
  utf("b"),
  utf("k/1"),
  utf("k/2"),
  utf("L".repeat(8 * 1024)),
];
/** Only increments write it, so its value counts them. */
const COUNTER = utf("ctr");
const keyArb = fc.nat({ max: KEYS.length - 1 });

type ValueSpec = { readonly size: number; readonly fill: string };
const valueArb: fc.Arbitrary<ValueSpec> = fc.record({
  size: fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 0, max: 16 }) },
    { weight: 2, arbitrary: fc.integer({ min: 3_000, max: 6_000 }) },
    { weight: 1, arbitrary: fc.constant(64 * 1024) },
  ),
  fill: fc.constantFrom("a", "b"),
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
    limit: fc.integer({ min: 0, max: 3 }),
    contains: fc.constantFrom("a", "v1", "."),
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
const readName = (r: ReadSpec) => (r.kind === "get" ? `get ${keyName(r.key)}` : `range ${JSON.stringify(r.range)}`);

// --- Commands. The model is which slots hold an open handle.

type Model = { readonly open: boolean[] };
type Cmd = fc.AsyncCommand<Model, World, false>;

const waitTag = (wait: boolean) => (wait ? "" : " &");

function opsOf(w: World, specs: readonly OpSpec[]): OracleOp[] {
  return specs.map((op) =>
    op.type === "put" ? { type: "put", key: KEYS[op.key]!, value: w.value(op.value) } : { type: "del", key: KEYS[op.key]! },
  );
}

function applyOps(tx: { put(k: Uint8Array, v: Uint8Array): void; delete(k: Uint8Array): void }, ops: readonly OracleOp[]) {
  for (const op of ops) {
    if (op.type === "put") tx.put(op.key, op.value);
    else tx.delete(op.key);
  }
}

abstract class SlotCmd implements Cmd {
  constructor(
    readonly slot: number,
    readonly wait: boolean,
  ) {}
  check(m: Readonly<Model>): boolean {
    return m.open[this.slot] === true;
  }
  abstract run(m: Model, w: World): Promise<void>;
  abstract name(): string;
  toString(): string {
    return `${this.slot}: ${this.name()}${waitTag(this.wait)}`;
  }
}

class WriteCmd extends SlotCmd {
  constructor(slot: number, wait: boolean, private readonly ops: readonly OpSpec[]) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    const ops = opsOf(w, this.ops);
    await w.start(this.slot, "write", { ops }, (db) => {
      if (ops.length === 1) {
        const op = ops[0]!;
        return op.type === "put" ? db.put(op.key, op.value) : db.delete(op.key);
      }
      return db.batch((tx) => applyOps(tx, ops));
    }, this.wait);
  }
  name = () => (this.ops.length === 1 ? opName(this.ops[0]!) : `batch[${this.ops.map(opName).join("; ")}]`);
}

/** Many keys in one batch: chunk splits, multi-block runs, and WAL bytes that trigger ingest. */
class BulkCmd extends SlotCmd {
  constructor(slot: number, wait: boolean, private readonly count: number, private readonly del: boolean) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    const ops: OracleOp[] = [];
    for (let i = 0; i < this.count; i++) {
      const key = utf(`n/${String(i).padStart(4, "0")}`);
      ops.push(this.del ? { type: "del", key } : { type: "put", key, value: w.value({ size: 8, fill: "b" }) });
    }
    await w.start(this.slot, "write", { ops }, (db) => db.batch((tx) => applyOps(tx, ops)), this.wait);
  }
  name = () => `bulk ${this.del ? "del" : "put"} ${this.count}`;
}

type UpdateAction = "keep" | "del" | "put";

class UpdateCmd extends SlotCmd {
  constructor(
    slot: number,
    wait: boolean,
    private readonly keys: readonly number[],
    private readonly actions: readonly UpdateAction[],
    private readonly value: ValueSpec,
  ) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    const keys = this.keys.map((k) => KEYS[k]!);
    const ops: OracleOp[] = [];
    keys.forEach((key, i) => {
      const action = this.actions[i % this.actions.length];
      if (action === "put") ops.push({ type: "put", key, value: w.value(this.value) });
      else if (action === "del") ops.push({ type: "del", key });
    });
    await w.start(this.slot, "update", { keys, ops }, (db, op) =>
      db.update(keys, (got, tx) => {
        op.seen = got.map((v) => (v ? new Uint8Array(v) : undefined));
        applyOps(tx, ops);
      }), this.wait);
  }
  name = () => `update[${this.keys.map((k, i) => `${keyName(k)}:${this.actions[i % this.actions.length]}`).join(", ")}]`;
}

/** Read-modify-write of one counter. Concurrent increments must not be lost. */
class IncrementCmd extends SlotCmd {
  async run(_m: Model, w: World): Promise<void> {
    const tag = w.uniq();
    await w.start(this.slot, "update", { keys: [COUNTER], ops: [] }, (db, op) =>
      db.update([COUNTER], ([cur], tx) => {
        op.seen = [cur ? new Uint8Array(cur) : undefined];
        const value = utf(`c${counterOf(cur) + 1}.${tag}`);
        op.ops = [{ type: "put", key: COUNTER, value }];
        tx.put(COUNTER, value);
      }), this.wait);
  }
  name = () => "increment";
}

function counterOf(v: Uint8Array | undefined): number {
  const m = v && /^c(\d+)\./.exec(dec.decode(v));
  return m ? Number(m[1]) : 0;
}

async function collect(w: World, it: AsyncIterable<Entry>, label: string): Promise<OracleEntry[]> {
  const out: OracleEntry[] = [];
  for await (const e of it) {
    out.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
    if (out.length === 1) await w.yield(`${label} mid-range`);
  }
  return out;
}

class GetCmd extends SlotCmd {
  constructor(slot: number, wait: boolean, private readonly key: number) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    const key = KEYS[this.key]!;
    await w.start(this.slot, "get", { key }, async (db, op) => {
      const v = await db.get(key);
      op.value = v && new Uint8Array(v);
    }, this.wait);
  }
  name = () => `get ${keyName(this.key)}`;
}

class RangeCmd extends SlotCmd {
  constructor(slot: number, wait: boolean, private readonly range: RangeSpec) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    const range = rangeOf(this.range);
    await w.start(this.slot, "range", { range }, async (db, op) => {
      op.entries = await collect(w, db.range(range), `${this.slot}`);
    }, this.wait);
  }
  name = () => `range ${JSON.stringify(this.range)}`;
}

/** Reads in one view, with a scheduler pause between them. */
class ViewCmd extends SlotCmd {
  constructor(slot: number, wait: boolean, private readonly reads: readonly ReadSpec[]) {
    super(slot, wait);
  }
  async run(_m: Model, w: World): Promise<void> {
    await w.start(this.slot, "view", { reads: [] as ViewRead[] }, (db, op) =>
      db.view(async (snap) => {
        for (const read of this.reads) {
          await w.yield(`${this.slot} view pause`);
          if (read.kind === "get") {
            const key = KEYS[read.key]!;
            const v = await snap.get(key);
            op.reads.push({ kind: "get", key, value: v && new Uint8Array(v) });
          } else {
            const range = rangeOf(read.range);
            op.reads.push({ kind: "range", range, entries: await collect(w, snap.range(range), `${this.slot} view`) });
          }
        }
      }), this.wait);
  }
  name = () => `view[${this.reads.map(readName).join("; ")}]`;
}

class SyncCmd extends SlotCmd {
  async run(_m: Model, w: World): Promise<void> {
    await w.start(this.slot, "sync", {}, (db) => db.sync(), this.wait);
  }
  name = () => "sync";
}

/** `ingest(db)`: flush through the head and wait for the compaction it starts. */
class IngestCmd extends SlotCmd {
  async run(_m: Model, w: World): Promise<void> {
    await w.start(this.slot, "ingest", {}, async (db) => void (await ingest(db)), this.wait);
  }
  name = () => "ingest";
}

class OpenCmd implements Cmd {
  constructor(private readonly slot: number) {}
  check = (m: Readonly<Model>) => m.open[this.slot] === false;
  async run(m: Model, w: World): Promise<void> {
    m.open[this.slot] = true;
    await w.open(this.slot);
  }
  toString = () => `${this.slot}: open`;
}

class CloseCmd implements Cmd {
  constructor(private readonly slot: number) {}
  check = (m: Readonly<Model>) => m.open[this.slot] === true;
  async run(m: Model, w: World): Promise<void> {
    m.open[this.slot] = false;
    await w.close(this.slot);
  }
  toString = () => `${this.slot}: close`;
}

/** Host flush, compaction left running in the background. */
class FlushCmd implements Cmd {
  constructor(private readonly wait: boolean) {}
  check = () => true;
  run = (_m: Model, w: World) => w.hostWork(() => w.host.ingest(w.name, Number.POSITIVE_INFINITY, false), this.wait);
  toString = () => `host flush${waitTag(this.wait)}`;
}

/** One compaction pass, no flush. */
class CompactCmd implements Cmd {
  constructor(private readonly wait: boolean) {}
  check = () => true;
  run = (_m: Model, w: World) => w.hostWork(() => w.host.ingest(w.name, 0, true), this.wait);
  toString = () => `host compact${waitTag(this.wait)}`;
}

/** Hold the slot's run opens (see `World.hold`). */
class HoldOpensCmd extends SlotCmd {
  async run(_m: Model, w: World): Promise<void> {
    w.hold(`s${w.slots[this.slot]!.id}`);
  }
  name = () => "hold run opens";
}

/** Lose the next `n` BroadcastChannel deliveries. The WAL tail is the source of truth. */
class DropCmd implements Cmd {
  constructor(private readonly n: number) {}
  check = () => true;
  async run(_m: Model, w: World): Promise<void> {
    w.dropNext += this.n;
  }
  toString = () => `drop next ${this.n} messages`;
}

/** Let `n` scheduled tasks run: a delivery, a file call, a pause. */
class StepCmd implements Cmd {
  constructor(private readonly n: number) {}
  check = () => true;
  run = (_m: Model, w: World) => w.step(this.n);
  toString = () => `step ${this.n}`;
}

const SLOTS = 3;

export const multiCommandsArb = (replayPath?: string) => {
  const slot = fc.nat({ max: SLOTS - 1 });
  const wait = fc.boolean();
  return fc.commands<Model, World, false>(
    [
      fc.tuple(slot, wait, fc.array(opArb, { minLength: 1, maxLength: 1 })).map(([s, x, ops]) => new WriteCmd(s, x, ops)),
      fc.tuple(slot, wait, fc.array(opArb, { minLength: 1, maxLength: 1 })).map(([s, x, ops]) => new WriteCmd(s, x, ops)),
      fc.tuple(slot, wait, fc.array(opArb, { minLength: 2, maxLength: 5 })).map(([s, x, ops]) => new WriteCmd(s, x, ops)),
      fc.tuple(slot, wait, fc.integer({ min: 50, max: 400 }), fc.boolean()).map(([s, x, n, d]) => new BulkCmd(s, x, n, d)),
      fc
        .tuple(
          slot,
          wait,
          fc.array(keyArb, { minLength: 1, maxLength: 3 }),
          fc.array(fc.constantFrom<UpdateAction>("keep", "del", "put"), { minLength: 1, maxLength: 3 }),
          valueArb,
        )
        .map(([s, x, keys, actions, value]) => new UpdateCmd(s, x, keys, actions, value)),
      fc.tuple(slot, wait).map(([s, x]) => new IncrementCmd(s, x)),
      fc.tuple(slot, wait).map(([s, x]) => new IncrementCmd(s, x)),
      fc.tuple(slot, wait, keyArb).map(([s, x, k]) => new GetCmd(s, x, k)),
      fc.tuple(slot, wait, keyArb).map(([s, x, k]) => new GetCmd(s, x, k)),
      fc.tuple(slot, wait, rangeArb).map(([s, x, r]) => new RangeCmd(s, x, r)),
      fc.tuple(slot, wait, fc.array(readArb, { minLength: 1, maxLength: 3 })).map(([s, x, r]) => new ViewCmd(s, x, r)),
      fc.tuple(slot, wait).map(([s, x]) => new SyncCmd(s, x)),
      fc.tuple(slot, wait).map(([s, x]) => new IngestCmd(s, x)),
      slot.map((s) => new OpenCmd(s)),
      slot.map((s) => new CloseCmd(s)),
      wait.map((x) => new FlushCmd(x)),
      wait.map((x) => new CompactCmd(x)),
      fc.integer({ min: 1, max: 4 }).map((n) => new DropCmd(n)),
      slot.map((s) => new HoldOpensCmd(s, false)),
      fc.integer({ min: 1, max: 8 }).map((n) => new StepCmd(n)),
      fc.integer({ min: 1, max: 8 }).map((n) => new StepCmd(n)),
    ],
    { maxCommands: 60, size: "max", ...(replayPath ? { replayPath } : {}) },
  );
};

/**
 * One history: open every slot, run the commands under the scheduler, then
 * quiesce and check the history, the files, the oracle and a reopen.
 */
export async function runWorld(
  name: string,
  s: fc.Scheduler,
  maxWalBytes: number,
  cmds: Iterable<Cmd>,
): Promise<void> {
  const w = new World(name, s, maxWalBytes, SLOTS);
  world = w;
  try {
    const model: Model = { open: Array.from({ length: SLOTS }, () => true) };
    w.free = true;
    for (let i = 0; i < SLOTS; i++) await w.open(i);
    w.free = false;
    await fc.asyncModelRun(() => ({ model, real: w }), cmds);
    await w.quiesce();
    expect(w.hostErrors, "host flush and compaction errors").toEqual([]);

    const oracle = checkHistory(w.history);
    // Concurrent increments: none lost.
    const increments = w.history.ops.filter(
      (op) => op.kind === "update" && op.keys[0] === COUNTER && w.history.seqOf(op.id) !== undefined,
    ).length;
    expect(counterOf(oracle.valueAt(COUNTER)), "counter after every committed increment").toBe(increments);

    // The files: quiesce the host, then the integrity check against the oracle.
    await w.host.ingest(name, 0, true);
    const report = await checkDatabase(w.fs, name);
    expect(report.problems, "checkDatabase problems").toEqual([]);
    expect(report.orphans, "orphan runs").toEqual([]);
    expect(report.staleManifests, "stale manifests").toEqual([]);
    expect(report.head, "WAL head").toBe(oracle.head);
    expectEntries(report.state, oracle.stateAt(), "on-disk state");

    // Reopen and read everything back.
    await w.open(0);
    const all: OracleEntry[] = [];
    for await (const e of w.slots[0]!.db.range()) all.push({ key: e.key, value: e.value });
    expectEntries(all, oracle.stateAt(), "range after reopen");
  } finally {
    await w.dispose();
  }
}
