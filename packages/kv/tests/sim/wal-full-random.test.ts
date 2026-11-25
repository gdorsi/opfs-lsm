/**
 * docs/reserve.md, "Refused append", and README "Storage quota" and
 * "Errors": with a reserve, a WAL append the browser refuses runs once more
 * after the host released the reserve, and fails with `StorageFullError`
 * only when the origin still has no room. Under random puts, batches,
 * updates, flushes and closes on two handles, while the origin's limit
 * tightens and lifts at random:
 *
 * - every call settles, and rejects only with `StorageFullError`, or with
 *   `ClosedError` on a handle whose `close()` was called;
 * - the rows read afterwards, from both handles and from a reopen, are the
 *   fold of the acked writes in seq order, a refused write leaves nothing,
 *   and a write that failed with `ClosedError` lands whole or not at all;
 * - the updates of a counter lose nothing, and those of one handle commit
 *   in call order;
 * - an open handle writes again once the origin has room.
 *
 * A wider sweep, and a replay of one seed:
 *   KV_WALFULL_SEEDS=400 pnpm exec vitest run tests/sim/wal-full-random.test.ts
 *   KV_WALFULL_FIRST=<seed> KV_WALFULL_SEEDS=1 pnpm exec vitest run tests/sim/wal-full-random.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedError, StorageFullError, type Db } from "../../src/index.js";
import { createLocalIngestClient, destroyHarnessDb, EngineHost, ingest, MemoryFs, openHarnessDb } from "../../src/testing.js";
import { BudgetFs } from "./byte-budget.js";
import { Oracle, type OracleOp } from "./oracle.js";

const SEEDS = Number(process.env.KV_WALFULL_SEEDS ?? 12);
const FIRST = Number(process.env.KV_WALFULL_FIRST ?? (process.env.KV_WALFULL_SEEDS ? 1 + Math.floor(Math.random() * 2 ** 30) : 1));
const STEPS = 40;
const KiB = 1024;
const RESERVE = 16 * KiB;
const HANG_MS = 10_000;
const DATA = Array.from({ length: 8 }, (_, i) => `d${i}`);
const COUNTERS = ["c0", "c1", "c2"];

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => dec.decode(b);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Aborting = IDBTransaction & { _abort(errorName: string): void };

/**
 * `refuseWalAppends` of byte-budget.ts, except that a connection refuses
 * from the abort event on, as in a browser. That seam marks it one task
 * earlier, where the handle's next write fails with a ClosedError no browser gives.
 */
function refuseWalAppends(name: string, origin: { readonly free: number }): () => void {
  const walName = `opfs-lsm-wal/${name}`;
  const store = globalThis.IDBObjectStore.prototype;
  const database = globalThis.IDBDatabase.prototype;
  const { add } = store;
  const { transaction } = database;
  const groups = new WeakMap<IDBTransaction, { waiting: number; refused: boolean }>();
  const spent = new WeakSet<IDBDatabase>();
  database.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    if (spent.has(this) && args[1] === "readwrite") {
      throw new DOMException("this connection saw a quota abort", "InvalidStateError");
    }
    const tx = transaction.apply(this, args);
    // Registered before any listener of the page, so it runs first in the abort's dispatch.
    tx.addEventListener("abort", () => groups.get(tx)?.refused && spent.add(this));
    return tx;
  };
  store.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const req = add.call(this, value, key);
    const tx = this.transaction;
    if (tx.db.name !== walName || this.name !== "wal" || !(value instanceof ArrayBuffer)) return req;
    const group = groups.get(tx) ?? { waiting: 0, refused: false };
    groups.set(tx, group);
    group.waiting += 1;
    group.refused ||= value.byteLength > origin.free;
    req.addEventListener("success", () => {
      if (--group.waiting > 0 || !group.refused) return;
      tally.refusals += 1;
      (tx as Aborting)._abort("QuotaExceededError");
    });
    return req;
  };
  return () => {
    store.add = add;
    database.transaction = transaction;
  };
}

/** What the runs met, so the test can say they met it. */
const tally = { refusals: 0, full: 0, closed: 0 };

/** How a write ended: acked, refused for lack of room, or failed because its handle closed. */
type Ending = "acked" | "full" | "closed";

/** A put or a batch on the data keys. A batch also puts a witness key of its own. */
type DataWrite = { readonly ops: OracleOp[]; readonly witness?: string; ending?: Ending; seq?: number | undefined };

/** An update that appends its id to a counter. */
type CounterWrite = { readonly id: number; readonly db: Db; readonly counter: string; ending?: Ending };

let restore: (() => void) | undefined;
beforeEach(() => {
  // No handle has an onStorageFull handler, and a refused flush logs.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

async function run(seed: number): Promise<void> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const name = `wal-full-random-${seed}`;
  const fs = new MemoryFs();
  const budget = new BudgetFs(fs, 1 << 30);
  const host = new EngineHost(() => budget);
  restore = refuseWalAppends(name, budget);
  const open = () =>
    openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, reserveBytes: RESERVE });

  const problems: string[] = [];
  const asked = new WeakSet<Db>();
  const data: DataWrite[] = [];
  const counters: CounterWrite[] = [];
  let id = 0;

  /** Records how `call` ended, and any rejection the contract does not allow. */
  const track = <T>(db: Db, what: string, call: Promise<T>, end: (ending: Ending, value?: T) => void): Promise<void> =>
    call.then(
      (value) => end("acked", value),
      (err: unknown) => {
        if (err instanceof StorageFullError && err.code === "quota") {
          tally.full += 1;
          return end("full");
        }
        if (err instanceof ClosedError && asked.has(db)) {
          tally.closed += 1;
          return end("closed");
        }
        problems.push(`${what} rejected with ${String(err)}${err instanceof ClosedError ? " on a handle not asked to close" : ""}`);
      },
    );

  const value = (n: number) => `v${n}.${".".repeat(Math.floor(random() * 400))}`;

  const write = (db: Db): Promise<void> => {
    const n = ++id;
    const roll = random();
    if (roll < 0.3) {
      const op: OracleOp = { type: "put", key: utf(pick(DATA)), value: utf(value(n)) };
      const w: DataWrite = { ops: [op] };
      data.push(w);
      return track(db, `put ${n}`, db.put(op.key, (op as { value: Uint8Array }).value), (ending, seq) => {
        w.ending = ending;
        w.seq = seq;
      });
    }
    if (roll < 0.55) {
      const witness = `w${n}`;
      const ops: OracleOp[] = [];
      for (let i = 1 + Math.floor(random() * 3); i > 0; i--) {
        ops.push(random() < 0.75 ? { type: "put", key: utf(pick(DATA)), value: utf(value(n)) } : { type: "del", key: utf(pick(DATA)) });
      }
      ops.push({ type: "put", key: utf(witness), value: utf("1") });
      const w: DataWrite = { ops, witness };
      data.push(w);
      return track(
        db,
        `batch ${n}`,
        db.batch((tx) => {
          for (const op of ops) {
            if (op.type === "put") tx.put(op.key, op.value);
            else if (op.type === "del") tx.delete(op.key);
          }
        }),
        (ending, seq) => {
          w.ending = ending;
          w.seq = seq;
        },
      );
    }
    if (roll < 0.85) {
      const counter = pick(COUNTERS);
      const w: CounterWrite = { id: n, db, counter };
      counters.push(w);
      const key = utf(counter);
      return track(
        db,
        `update ${n}`,
        db.update([key], ([cur], tx) => tx.put(key, utf(`${cur ? text(cur) : ""},${n}`))),
        (ending) => void (w.ending = ending),
      );
    }
    // A flush the full origin refuses fails too. The in-process host passes on the browser's
    // QuotaExceededError, which a port turns into StorageFullError.
    const flush = ingest(db).catch((err: unknown) => {
      throw err instanceof DOMException && err.name === "QuotaExceededError" ? new StorageFullError("flush refused", { cause: err }) : err;
    });
    return track(db, `ingest ${n}`, flush, () => undefined);
  };

  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) await (random() < 0.5 ? Promise.resolve() : new Promise((r) => setImmediate(r)));
  };
  const tighten = () => (budget.limit = budget.used + Math.floor(random() * 600));
  const lift = () => (budget.limit = budget.used + RESERVE * 4 + Math.floor(random() * 64 * KiB));

  const slots: Db[] = [await open(), await open()];
  await write(slots[0]!);
  await ingest(slots[0]!);

  for (let step = 0; step < STEPS; step++) {
    if (random() < 0.4) (random() < 0.5 ? tighten : lift)();
    const calls: Promise<void>[] = [];
    for (let i = 1 + Math.floor(random() * 4); i > 0; i--) calls.push(write(pick(slots)));
    const closing = random() < 0.15 ? Math.floor(random() * slots.length) : -1;
    await turns(Math.floor(random() * 5));
    if (random() < 0.3) (random() < 0.6 ? tighten : lift)();
    if (closing >= 0) {
      const db = slots[closing]!;
      asked.add(db);
      calls.push(track(db, "close", db.close(), () => undefined));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<string>((resolve) => (timer = setTimeout(resolve, HANG_MS, "hung")));
    const outcome = await Promise.race([Promise.all(calls).then(() => "settled"), hung]);
    clearTimeout(timer);
    expect(outcome, `seed ${seed}, step ${step}: every call settles`).toBe("settled");
    expect(problems, `seed ${seed}, step ${step}: rejections`).toEqual([]);
    if (closing >= 0) slots[closing] = await open();
  }

  budget.limit = budget.used + (1 << 30);
  for (const [i, db] of slots.entries()) {
    const op: OracleOp = { type: "put", key: utf(DATA[i]!), value: utf(`room ${i}`) };
    const seq = await db.put(op.key, utf(`room ${i}`)).catch((err: unknown) => `${err}`);
    expect(seq, `seed ${seed}: handle ${i} writes again once the origin has room`).toBeTypeOf("number");
    data.push({ ops: [op], ending: "acked", seq: seq as number });
  }

  const expected = expectation(data, counters);
  for (const db of slots) await db.sync();
  for (const [i, db] of slots.entries()) expected.check(await rowsOf(db), `seed ${seed}: handle ${i}`);
  for (const db of slots) await db.close();
  const again = await open();
  expected.check(await rowsOf(again), `seed ${seed}: a reopen`);
  await again.close();
  restore();
  restore = undefined;
  await destroyHarnessDb({ name, fs });
}

async function rowsOf(db: Db): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  for await (const e of db.range()) rows.set(text(e.key), text(e.value));
  return rows;
}

/**
 * What the rows may be: the fold of the acked data writes in seq order, a
 * key touched by a write that failed with ClosedError also holding what that
 * write left, and each counter the ids of its acked updates.
 */
function expectation(data: readonly DataWrite[], counters: readonly CounterWrite[]) {
  const acked = data.filter((w) => w.ending === "acked").sort((a, b) => a.seq! - b.seq!);
  const oracle = new Oracle();
  for (const w of acked) {
    while (oracle.head < w.seq! - 1) oracle.appendRow([]);
    expect(oracle.head, `two acked writes share seq ${w.seq}`).toBe(w.seq! - 1);
    oracle.appendRow(w.ops);
  }
  const allowed = new Map<string, Set<string | undefined>>();
  for (const key of DATA) {
    const v = oracle.valueAt(utf(key));
    allowed.set(key, new Set([v && text(v)]));
  }
  for (const w of data) {
    if (w.ending !== "closed") continue;
    for (const op of w.ops) {
      if (op.type === "put" || op.type === "del") allowed.get(text(op.key))?.add(op.type === "put" ? text(op.value) : undefined);
    }
  }
  const witnesses = new Map(data.filter((w) => w.witness).map((w) => [w.witness!, w.ending]));

  return {
    check(rows: Map<string, string>, label: string): void {
      for (const key of DATA) {
        const got = rows.get(key);
        const want = allowed.get(key)!;
        const show = (v: string | undefined) => (v === undefined ? "no row" : v.slice(0, 12));
        expect(want.has(got), `${label}: ${key} reads ${show(got)}, the writes allow ${[...want].map(show).join(" or ")}`).toBe(true);
      }
      for (const [key, ending] of witnesses) {
        if (ending === "closed") continue;
        expect(rows.has(key), `${label}: the batch of ${key} ended ${ending}`).toBe(ending === "acked");
      }
      for (const counter of COUNTERS) {
        const ids = (rows.get(counter) ?? "").split(",").filter(Boolean).map(Number);
        const mine = counters.filter((w) => w.counter === counter);
        const ending = new Map(mine.map((w) => [w.id, w.ending]));
        expect(new Set(ids).size, `${label}: ${counter} holds an update twice: ${ids}`).toBe(ids.length);
        for (const n of ids) expect(ending.get(n), `${label}: ${counter} holds update ${n}`).toMatch(/^(acked|closed)$/);
        for (const w of mine) if (w.ending === "acked") expect(ids, `${label}: ${counter} lost the acked update ${w.id}`).toContain(w.id);
        const byDb = new Map<Db, number[]>();
        for (const n of ids) {
          const db = mine.find((w) => w.id === n)!.db;
          byDb.set(db, [...(byDb.get(db) ?? []), n]);
        }
        for (const order of byDb.values()) {
          expect(order, `${label}: the updates of one handle on ${counter} commit in call order`).toEqual([...order].sort((a, b) => a - b));
        }
      }
    },
  };
}

describe("WAL appends refused at random", () => {
  it("settle, reject only with StorageFullError or ClosedError, and leave exactly the acked writes", async () => {
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) await run(seed);
    expect(tally.refusals, "the runs met refused appends").toBeGreaterThan(0);
    expect(tally.full, "the runs met StorageFullError").toBeGreaterThan(0);
    expect(tally.closed, "the runs met ClosedError").toBeGreaterThan(0);
  }, 900_000);
});
