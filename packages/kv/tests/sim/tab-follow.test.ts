/**
 * TabFollow: every short sequence of commands on two handles of one
 * database, on the real `Db`, host and WAL (fake-indexeddb, MemoryFs).
 *
 * The formal checks model the disk, the files a tab holds and one key under
 * `update`. This runs what they leave out, exhaustively at a small bound: a
 * tab's generation installs, `dangerousDestroy` with a second handle open,
 * and `changes()` on a handle that is not the only writer.
 *
 * Commands run one at a time. BroadcastChannel is a queue that only the
 * `deliver` command empties, so a handle lags the other until it hears or
 * syncs. After every command, on every handle:
 *
 * - TabPrefix: a `view` reads exactly `fold(log[1..snap.seq])`, where a
 *   `dangerousDestroy` is one log entry that deletes every key (design.md,
 *   "Destroy"), and `get`, `range` and `count` outside it read the same.
 *   `snap.seq` is at or past the handle's last read, its last ack, the
 *   destroy it called, and every seq acked before its last `sync` or open.
 * - UpdateExact: an `update` that committed at seq `s` read `fold(log[1..s-1])`.
 * - ViewStable: a view held open across the next commands reads at its
 *   close what it read at its start.
 * - ChangesExact (design.md, "Change events"): the handle's listener got
 *   one `append` per applied seq, in seq order with none skipped, or a `gap`
 *   that covers it; a read started inside the listener is at or past the
 *   event's seq; its events reach exactly `snap.seq`; and a replica that
 *   applies the events' ops, and reads again after a `gap`, equals what the
 *   handle reads.
 * After the sequence both handles sync and read the fold of the whole log,
 * and `checkDatabase` finds the files healthy and holding that state.
 *
 * `KV_FOLLOW_DEPTH` (default 3) is the length of the sequences after each of
 * the two starts: an empty database, and one whose first write is flushed
 * and installed by both handles. A failure prints its sequence:
 *   KV_FOLLOW_SEQ="A.put, flush, B.sync" pnpm exec vitest run tests/sim/tab-follow.test.ts
 * Add KV_FOLLOW_TRACE=1 to print each command as it runs.
 *
 * The broken variants patch one decision of the real `DbImpl` and must each
 * fail, so the check is shown to be able to.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareBytes, keyToString } from "../../src/bytes.js";
import type { ChangeEvent, Db, ViewSnapshot } from "../../src/index.js";
import { TabWal, decodeOps } from "../../src/idb/wal.js";
import { EngineHost, MemoryFs, createLocalIngestClient, openHarnessDb } from "../../src/testing.js";
import { checkDatabase, deleteWal, walMeta } from "./check-database.js";
import { Oracle, show, type OracleEntry, type OracleOp } from "./oracle.js";

const DEPTH = Number(process.env.KV_FOLLOW_DEPTH ?? 3);
/** One sequence to replay, as a failure prints it: `A.put, flush, B.sync`. */
const REPLAY = process.env.KV_FOLLOW_SEQ?.split(",").map((c) => c.trim()) as Cmd[] | undefined;
/** How long one sequence may take before it counts as stuck. */
const SETTLE_MS = 5_000;
const trace = (line: string) => {
  if (process.env.KV_FOLLOW_TRACE) console.log(line);
};

const enc = new TextEncoder();
const K1 = enc.encode("k1");
const K2 = enc.encode("k2");
const KEYS = [K1, K2];

// --- BroadcastChannel as a queue the test empties.

type Listener = (ev: { data: unknown }) => void;

class QueuedChannel {
  static readonly open = new Map<string, Set<QueuedChannel>>();
  static queue: (() => void)[] = [];

  onmessage: Listener | null = null;
  private readonly listeners = new Set<Listener>();
  private closed = false;

  constructor(readonly name: string) {
    let set = QueuedChannel.open.get(name);
    if (!set) QueuedChannel.open.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException("channel is closed", "InvalidStateError");
    for (const to of QueuedChannel.open.get(this.name) ?? []) {
      if (to === this) continue;
      const copy = structuredClone(data);
      QueuedChannel.queue.push(() => to.dispatch(copy));
    }
  }

  addEventListener(_type: "message", fn: Listener): void {
    this.listeners.add(fn);
  }

  removeEventListener(_type: "message", fn: Listener): void {
    this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    QueuedChannel.open.get(this.name)?.delete(this);
  }

  private dispatch(data: unknown): void {
    if (this.closed) return;
    const ev = { data };
    this.onmessage?.(ev);
    for (const fn of this.listeners) fn(ev);
  }

  static deliver(): void {
    for (const run of QueuedChannel.queue.splice(0)) run();
  }
}

// --- Seams: the log as the WAL commits it, and the channel.

let world: World | undefined;
let restore = () => {};

beforeAll(() => {
  const open = TabWal.open;
  TabWal.open = async (...args) => {
    const wal = await open(...args);
    const { append, appendAfter } = wal;
    wal.append = async (record) => {
      const seq = await append(record);
      world?.commit(seq, decodeOps(record, seq));
      return seq;
    };
    wal.appendAfter = (async (since: Parameters<typeof appendAfter>[0], decide: Parameters<typeof appendAfter>[1]) => {
      const out = await appendAfter(since, decide);
      if (out?.seq !== undefined) world?.commit(out.seq, out.ops);
      return out;
    }) as typeof appendAfter;
    return wal;
  };
  const g = globalThis as { BroadcastChannel?: unknown };
  const realChannel = g.BroadcastChannel;
  g.BroadcastChannel = QueuedChannel;
  restore = () => {
    TabWal.open = open;
    g.BroadcastChannel = realChannel;
  };
});

afterAll(() => restore());

// --- The system under test.

type Row = { readonly key: Uint8Array; readonly value: Uint8Array; readonly seq: number };

type Read = { readonly seq: number; readonly entries: OracleEntry[]; readonly gets: (Uint8Array | undefined)[] };

type Tab = {
  readonly id: "A" | "B";
  db: Db;
  /** The lowest prefix its next read may be. */
  floor: number;
  /** The seq its change events reach. */
  last: number;
  /** A `gap` came since the replica was last read. */
  stale: boolean;
  replica: Map<string, Row>;
  faults: string[];
  /** Catch-ups in flight, the ones a message started included. */
  readonly syncs: Set<Promise<unknown>>;
  held: { readonly release: () => void; readonly done: Promise<{ seq: number; first: Read; second: Read }> } | undefined;
};

type Cmd = "A.put" | "B.put" | "A.deleteAll" | "A.destroy" | "A.sync" | "B.sync" | "flush" | "deliver" | "B.update" | "B.view" | "B.reopen";
const CMDS: readonly Cmd[] = ["A.put", "B.put", "A.deleteAll", "A.destroy", "A.sync", "B.sync", "flush", "deliver", "B.update", "B.view", "B.reopen"];
/** Twice in a row, the second does nothing the first did not. */
const IDEMPOTENT = new Set<Cmd>(["A.sync", "B.sync", "flush", "deliver"]);

async function collect(it: AsyncIterable<OracleEntry>): Promise<OracleEntry[]> {
  const out: OracleEntry[] = [];
  for await (const e of it) out.push({ key: e.key, value: e.value });
  return out;
}

async function readSnap(snap: ViewSnapshot): Promise<Read> {
  return { seq: snap.seq, entries: await collect(snap.range()), gets: await snap.getMany(KEYS) };
}

const fmt = (entries: readonly OracleEntry[]) => `[${entries.map((e) => `${show(e.key)}=${show(e.value)}`).join(", ")}]`;
const same = (a: readonly OracleEntry[], b: readonly OracleEntry[]) => fmt(a) === fmt(b);

class World {
  private static count = 0;
  readonly name = `tab-follow-${World.count++}`;
  readonly fs = new MemoryFs();
  // No flush or compaction pass on a timer: only the `flush` command and a destroy start one.
  readonly host = new EngineHost(() => this.fs, { idleFlushMs: 1_000_000_000, idleFlushDueMs: 1_000_000_000 });
  readonly oracle = new Oracle();
  readonly tabs = new Map<"A" | "B", Tab>();
  private nextValue = 1;
  /** The seq of the last committed row that has ops. */
  private lastWrite = 0;

  commit(seq: number, ops: readonly unknown[]): void {
    if (seq !== this.oracle.head + 1) throw new Error(`a row committed at seq ${seq} with the log at ${this.oracle.head}`);
    this.oracle.appendRow(ops as OracleOp[]);
    if (ops.length > 0) this.lastWrite = seq;
  }

  private value(): Uint8Array {
    return enc.encode(`v${this.nextValue++}`);
  }

  async open(id: "A" | "B"): Promise<void> {
    const db = await openHarnessDb({
      name: this.name,
      fs: this.fs,
      ingest: createLocalIngestClient(this.host),
      maxWalBytes: 1 << 30,
      rowPostMs: 0,
    });
    const tab: Tab = { id, db, floor: this.oracle.head, last: 0, stale: false, replica: new Map(), faults: [], syncs: new Set(), held: undefined };
    const inner = db as unknown as { catchUpToWal: () => Promise<void> };
    const catchUp = inner.catchUpToWal;
    inner.catchUpToWal = () => {
      const p = catchUp();
      tab.syncs.add(p);
      void p.then(
        () => tab.syncs.delete(p),
        () => tab.syncs.delete(p),
      );
      return p;
    };
    db.changes((e) => this.heard(tab, e));
    const now = await db.view(readSnap);
    tab.last = now.seq;
    for (const e of now.entries) tab.replica.set(keyToString(e.key), { ...e, seq: now.seq });
    this.tabs.set(id, tab);
  }

  private heard(tab: Tab, e: ChangeEvent): void {
    // A view pins in the turn it is called in, so this reads what the listener can read now.
    const at = e.kind === "append" ? e.seq : e.kind === "gap" ? e.through : undefined;
    if (at !== undefined) {
      void tab.db
        .view((snap) => {
          if (snap.seq < at) tab.faults.push(`${e.kind} ${at} announced while the handle reads at seq ${snap.seq}`);
        })
        .catch(() => undefined);
    }
    if (e.kind === "append") {
      if (e.seq !== tab.last + 1) tab.faults.push(`append ${e.seq} announced with its events at ${tab.last}`);
      tab.last = e.seq;
      if (tab.stale) return;
      for (const op of e.ops) {
        if (op.type === "put") tab.replica.set(keyToString(op.key), { key: op.key, value: op.value, seq: e.seq });
        else if (op.type === "del") tab.replica.delete(keyToString(op.key));
        else {
          for (const [id, row] of tab.replica) {
            const inside = compareBytes(row.key, op.start) >= 0 && (!op.endExclusive || compareBytes(row.key, op.endExclusive) < 0);
            if (inside && row.seq <= op.through) tab.replica.delete(id);
          }
        }
      }
    } else if (e.kind === "gap") {
      if (e.through < tab.last) tab.faults.push(`gap through ${e.through} announced with its events at ${tab.last}`);
      tab.last = e.through;
      tab.stale = true;
    }
  }

  /** Wait for every catch-up a message started. */
  private async idle(): Promise<void> {
    for (let quiet = 0; quiet < 2; ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const running = [...this.tabs.values()].flatMap((t) => [...t.syncs]);
      if (running.length === 0) quiet++;
      else {
        quiet = 0;
        await Promise.allSettled(running);
      }
    }
  }

  async run(cmd: Cmd): Promise<void> {
    trace(`[cmd] ${cmd}`);
    const tab = this.tabs.get(cmd[0] as "A" | "B");
    switch (cmd) {
      case "A.put":
      case "B.put": {
        const seq = await tab!.db.put(cmd === "A.put" ? K1 : K2, this.value());
        expect(seq, "the seq a put resolves with").toBe(this.oracle.head);
        tab!.floor = Math.max(tab!.floor, seq);
        break;
      }
      case "A.deleteAll": {
        const seq = await tab!.db.batch((tx) => tx.deleteRange({}));
        tab!.floor = Math.max(tab!.floor, seq);
        break;
      }
      case "A.destroy": {
        const at = this.oracle.head + 1;
        await tab!.db.dangerousDestroy();
        const meta = await walMeta(this.name);
        expect([meta.head, meta.ingestedThrough, meta.generation], "a destroy takes the next seq and records generation 0").toEqual([at, at, 0]);
        this.oracle.appendRow([{ type: "deleteRange", start: new Uint8Array(0) }]);
        tab!.floor = at;
        break;
      }
      case "A.sync":
      case "B.sync": {
        const head = this.oracle.head;
        await tab!.db.sync();
        tab!.floor = Math.max(tab!.floor, head);
        break;
      }
      case "flush":
        await this.host.ingest(this.name, true);
        break;
      case "deliver":
        QueuedChannel.deliver();
        break;
      case "B.update": {
        let seen: Uint8Array | undefined;
        const value = this.value();
        await tab!.db.update([K1], ([cur], tx) => {
          seen = cur;
          tx.put(K1, value);
        });
        const s = this.lastWrite;
        expect(this.oracle.valueAt(K1, s), "the update's row is the last write").toEqual(value);
        const want = this.oracle.valueAt(K1, s - 1);
        if (!sameValue(seen, want)) throw new Error(`UpdateExact: the update committed at seq ${s} and read ${showValue(seen)}, not ${showValue(want)}`);
        tab!.floor = Math.max(tab!.floor, s);
        break;
      }
      case "B.view":
        if (tab!.held) await this.closeView(tab!);
        else await this.openView(tab!);
        break;
      case "B.reopen": {
        if (tab!.held) await this.closeView(tab!);
        await tab!.db.close();
        await this.open("B");
        break;
      }
    }
    trace(`[idle] after ${cmd}`);
    await this.idle();
    for (const t of this.tabs.values()) await this.check(t);
  }

  private async openView(tab: Tab): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    const done = tab.db.view(async (snap) => {
      const first = await readSnap(snap);
      started();
      await gate;
      return { seq: snap.seq, first, second: await readSnap(snap) };
    });
    done.catch(() => started());
    await reading;
    tab.held = { release, done };
  }

  private async closeView(tab: Tab): Promise<void> {
    const held = tab.held!;
    tab.held = undefined;
    held.release();
    const { seq, first, second } = await held.done;
    const want = this.oracle.rangeAt({}, seq);
    if (!same(first.entries, want)) throw new Error(`TabPrefix: ${tab.id}'s held view at seq ${seq} read ${fmt(first.entries)}, the log gives ${fmt(want)}`);
    if (!same(second.entries, first.entries) || !second.gets.every((v, i) => sameValue(v, first.gets[i]))) {
      throw new Error(`ViewStable: ${tab.id}'s view at seq ${seq} read ${fmt(first.entries)}, then ${fmt(second.entries)} at its close`);
    }
  }

  private async check(tab: Tab): Promise<void> {
    const { db, id } = tab;
    trace(`[check] ${id}`);
    const got = await db.view(readSnap);
    const { seq } = got;
    if (seq < tab.floor || seq > this.oracle.head) throw new Error(`TabPrefix: ${id} reads at seq ${seq}, its floor is ${tab.floor} and the head ${this.oracle.head}`);
    tab.floor = seq;
    const want = this.oracle.rangeAt({}, seq);
    if (!same(got.entries, want)) throw new Error(`TabPrefix: ${id} at seq ${seq} reads ${fmt(got.entries)}, the log gives ${fmt(want)}`);
    KEYS.forEach((k, i) => {
      if (!sameValue(got.gets[i], this.oracle.valueAt(k, seq))) throw new Error(`TabPrefix: ${id} at seq ${seq} gets ${show(k)} = ${showValue(got.gets[i])}`);
    });
    // Nothing runs between the view and these, so they read the same prefix.
    const [range, count, gets] = [await collect(db.range()), await db.count(), await Promise.all(KEYS.map((k) => db.get(k)))];
    if (!same(range, want) || count !== want.length || !gets.every((v, i) => sameValue(v, got.gets[i]))) {
      throw new Error(`TabPrefix: ${id} at seq ${seq} reads ${fmt(range)} (count ${count}) outside a view, the log gives ${fmt(want)}`);
    }
    if (tab.faults.length > 0) throw new Error(`ChangesExact: ${id}: ${tab.faults.join("; ")}`);
    if (tab.last !== seq) throw new Error(`ChangesExact: ${id} reads at seq ${seq} and its events reach ${tab.last}`);
    if (tab.stale) {
      tab.stale = false;
      tab.replica = new Map(got.entries.map((e) => [keyToString(e.key), { ...e, seq }]));
      return;
    }
    const replica = [...tab.replica.values()].sort((a, b) => compareBytes(a.key, b.key));
    if (!same(replica, want)) throw new Error(`ChangesExact: ${id} at seq ${seq}: a replica of its events holds ${fmt(replica)}, it reads ${fmt(want)}`);
  }

  /** Both handles sync and read the whole log, and the files hold it. */
  async finish(): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (tab.held) await this.closeView(tab);
      const head = this.oracle.head;
      await tab.db.sync();
      tab.floor = head;
      await this.idle();
      await this.check(tab);
    }
    await this.host.ingest(this.name, true);
    const report = await checkDatabase(this.fs, this.name);
    if (report.problems.length > 0) throw new Error(`checkDatabase: ${report.problems.join("; ")}`);
    const want = this.oracle.stateAt();
    if (report.head !== this.oracle.head || !same(report.state, want)) {
      throw new Error(`the files hold ${fmt(report.state)} at head ${report.head}, the log gives ${fmt(want)} at ${this.oracle.head}`);
    }
  }

  async dispose(): Promise<void> {
    for (const tab of this.tabs.values()) {
      tab.held?.release();
      await tab.held?.done.catch(() => undefined);
      await tab.db.close().catch(() => undefined);
    }
    QueuedChannel.queue = [];
    await deleteWal(this.name);
  }
}

function sameValue(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return compareBytes(a, b) === 0;
}

const showValue = (v: Uint8Array | undefined) => (v === undefined ? "undefined" : show(v));

/** Run `cmds` on a fresh database. The first broken promise, with the sequence, or undefined. */
async function runSequence(cmds: readonly Cmd[]): Promise<string | undefined> {
  const w = new World();
  world = w;
  let at = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A broken variant can leave a catch-up retrying for ever: that is a failure, not a hang of the check.
    const stuck = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${SETTLE_MS} ms`)), SETTLE_MS);
    });
    await Promise.race([
      stuck,
      (async () => {
        await w.open("A");
        await w.open("B");
        for (; at < cmds.length; at++) await w.run(cmds[at]!);
        await w.finish();
      })(),
    ]);
    return undefined;
  } catch (err) {
    const where = at < cmds.length ? `after command ${at + 1}` : "after the last command";
    return `[${cmds.join(", ")}] ${where}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
    await w.dispose();
    world = undefined;
  }
}

/** Every sequence of 1 to `depth` commands, without an idempotent command twice in a row. */
function* sequences(depth: number, prefix: Cmd[] = []): Generator<Cmd[]> {
  if (prefix.length > 0) yield prefix;
  if (prefix.length === depth) return;
  for (const c of CMDS) {
    if (IDEMPOTENT.has(c) && prefix[prefix.length - 1] === c) continue;
    yield* sequences(depth, [...prefix, c]);
  }
}

/** The second start: the first write is in a run, and both handles have installed its generation. */
const FLUSHED: readonly Cmd[] = ["A.put", "flush", "deliver"];
const STARTS: readonly (readonly Cmd[])[] = [[], FLUSHED];

/** Every sequence after each start. Stops at the first that breaks a promise. */
async function explore(depth: number): Promise<{ readonly ran: number; readonly failure: string | undefined }> {
  let ran = 0;
  for (const start of STARTS) {
    for (const tail of sequences(depth)) {
      ran++;
      const failure = await runSequence([...start, ...tail]);
      if (failure) return { ran, failure };
    }
  }
  return { ran, failure: undefined };
}

// --- Broken variants: one decision of the real DbImpl, patched on its prototype.

type Proto = Record<string, (this: Record<string, unknown>, ...args: never[]) => unknown>;

async function dbProto(): Promise<Proto> {
  const fs = new MemoryFs();
  const name = "tab-follow-proto";
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)), maxWalBytes: 1 << 30 });
  const proto = Object.getPrototypeOf(db) as Proto;
  await db.close();
  await deleteWal(name);
  return proto;
}

type Variant = { readonly name: string; readonly method: string; readonly broken: (original: (...args: never[]) => unknown) => (this: never, ...args: never[]) => unknown };

const VARIANTS: readonly Variant[] = [
  {
    name: "a tab keeps a generation above the one a destroy recorded",
    method: "has",
    broken: (has) =>
      function (this: never, generation: never) {
        return (has as (this: never, g: never, ahead: boolean) => unknown).call(this, generation, false);
      },
  },
  {
    name: "a generation install that jumps the memtable announces no gap",
    method: "advance",
    broken: () =>
      function (this: { mem: { advanceTo(through: number): boolean }; repaired: boolean }, through: number) {
        this.mem.advanceTo(through);
        this.repaired = false;
      } as never,
  },
  {
    name: "a record the memtable already holds is announced again",
    method: "applyRecord",
    broken: () =>
      function (this: { mem: { apply(r: unknown): string }; unannounced: unknown[] }, record: { seq: number; ops: unknown }) {
        const applied = this.mem.apply(record);
        if (applied !== "gap") this.unannounced.push({ kind: "append", seq: record.seq, ops: record.ops });
        return applied;
      } as never,
  },
  {
    name: "a record is announced before the memtable holds it",
    method: "applyRecord",
    broken: (applyRecord) =>
      function (this: { mem: { appliedThrough: number }; unannounced: unknown[]; announce(): void }, record: { seq: number; ops: unknown }) {
        if (record.seq === this.mem.appliedThrough + 1) {
          this.unannounced.push({ kind: "append", seq: record.seq, ops: record.ops });
          this.announce();
          this.unannounced.pop();
        }
        return (applyRecord as (this: unknown, r: unknown) => unknown).call(this, record);
      } as never,
  },
  {
    name: "a generation install leaves the memtable as it was",
    method: "advance",
    broken: () => function () {} as never,
  },
];

describe("TabFollow (two handles, real Db)", () => {
  it.runIf(REPLAY)("replays KV_FOLLOW_SEQ", async () => {
    expect(await runSequence(REPLAY!)).toBeUndefined();
  }, 60_000);

  it.skipIf(REPLAY)("catches each broken variant", async () => {
    const proto = await dbProto();
    for (const v of VARIANTS) {
      const original = proto[v.method]!;
      expect(typeof original, `DbImpl.${v.method} exists`).toBe("function");
      proto[v.method] = v.broken(original as never) as never;
      try {
        const { failure } = await explore(Math.min(DEPTH, 3));
        expect(failure, `model too weak: the broken variant "${v.name}" passes`).toBeDefined();
        console.log(`  broken variant caught: ${v.name}\n    ${failure!.split("\n")[0]}`);
      } finally {
        proto[v.method] = original;
      }
    }
  }, 600_000);

  it.skipIf(REPLAY)(`every sequence of up to ${DEPTH} commands reads log prefixes and announces every seq once`, async () => {
    const { ran, failure } = await explore(DEPTH);
    expect(failure, "FAIL TabFollow").toBeUndefined();
    console.log(`PASS TabFollow — ${ran} command sequences on two handles: TabPrefix, UpdateExact, ViewStable, ChangesExact`);
  }, 1_800_000);
});
