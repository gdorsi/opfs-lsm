import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import type { Range } from "../src/db.js";
import type { LogId, QueueCursor } from "../src/host/queues.js";
import { OwnQueue } from "../src/log/overlay.js";
import { settle } from "../src/store/cursor.js";
import type { MemRows } from "../src/store/memtable.js";
import { pointGet, RunLevel } from "../src/store/merge.js";
import { encodeRun, type SstEntry } from "../src/store/sst.js";
import { boundsOf, scanLayers } from "../src/view.js";
import { collect, readerOfBytes } from "./runs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const A = "a" as LogId;
const B = "b" as LogId;

const k = (s: string) => enc.encode(s) as CheckedKey;
const put = (key: string, value: string): CheckedOp => ({ type: "put", key: k(key), value: enc.encode(value) as CheckedValue });
const del = (key: string): CheckedOp => ({ type: "del", key: k(key) });
const open = (log: LogId, n: number): QueueCursor => ({ log, state: "open", n });
const final = (log: LogId, n: number): QueueCursor => ({ log, state: "final", n });
const damaged = (log: LogId, n: number): QueueCursor => ({ log, state: "damaged", n, reason: "hole" });

/** The installed runs: k1..k4 with run values, and a tombstone at k5. */
const levels = [
  new RunLevel([
    readerOfBytes(
      encodeRun([
        ...["k1", "k2", "k3", "k4"].map((key): SstEntry => ({ kind: "put", key: k(key), value: enc.encode(`run-${key}`) })),
        { kind: "del", key: k("k5") },
      ]).body,
    ),
  ]),
];

/** What a page reads: the overlay's row, else the runs. */
async function read(rows: MemRows, key: string): Promise<string | undefined> {
  const value = await settle(() => pointGet(rows.get(k(key)), levels, k(key)));
  return value && dec.decode(value);
}

async function scan(rows: MemRows, range: Range = {}): Promise<string[]> {
  const bounds = boundsOf(range);
  const entries = await collect(scanLayers(rows.range(bounds), levels, bounds, range));
  return entries.map((e) => `${dec.decode(e.key)}=${dec.decode(e.value)}`);
}

describe("OwnQueue reads", () => {
  it("answers with the newest write of a key, a delete included", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("x", "2"), put("y", "1")]);
    own.add(A, 3, [del("y")]);
    expect(await read(own, "x")).toBe("2");
    expect(own.get(k("y"))?.kind).toBe("del");
    expect(await read(own, "y")).toBeUndefined();
  });

  it("puts every record of a newer log after every record of an older one", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "a1")]);
    own.add(A, 2, [put("x", "a2"), put("y", "a2")]);
    own.add(B, 1, [put("x", "b1")]);
    expect(await read(own, "x")).toBe("b1");
    expect(await read(own, "y")).toBe("a2");
  });

  it("falls through to the runs for a key it does not hold", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k2", "own")]);
    expect(own.get(k("k1"))).toBeUndefined();
    expect(await read(own, "k1")).toBe("run-k1");
    expect(await read(own, "k2")).toBe("own");
  });

  it("hides a run value under a delete, and shows a put over a run tombstone", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [del("k3"), put("k5", "own")]);
    expect(await read(own, "k3")).toBeUndefined();
    expect(await read(own, "k5")).toBe("own");
    expect(await read(own, "k4")).toBe("run-k4");
  });

  it("scans the overlay over the runs, with bounds, forward and reverse", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k2", "own2"), del("k3"), put("k35", "own35")]);
    own.add(B, 1, [put("k1", "own1"), put("k6", "own6")]);
    expect(await scan(own)).toEqual(["k1=own1", "k2=own2", "k35=own35", "k4=run-k4", "k6=own6"]);
    expect(await scan(own, { reverse: true })).toEqual(["k6=own6", "k4=run-k4", "k35=own35", "k2=own2", "k1=own1"]);
    const inside = { start: k("k2"), endExclusive: k("k4") };
    expect(await scan(own, inside)).toEqual(["k2=own2", "k35=own35"]);
    expect(await scan(own, { ...inside, reverse: true })).toEqual(["k35=own35", "k2=own2"]);
    expect(await scan(own, { start: k("k35"), reverse: true, limit: 2 })).toEqual(["k6=own6", "k4=run-k4"]);
  });
});

describe("OwnQueue install", () => {
  it("drops records up to the cursor and keeps the rest", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("z", "3")]);
    own.install([open(A, 2)]);
    expect(own.get(k("x"))).toBeUndefined();
    expect(own.get(k("y"))).toBeUndefined();
    expect(await read(own, "z")).toBe("3");
    expect(own.above(A, 0).map((r) => r.n)).toEqual([3]);
  });

  it("reads the later value of a key after the earlier record that wrote it is dropped", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k1", "first")]);
    own.add(A, 2, [put("other", "x")]);
    own.add(A, 3, [put("k1", "third")]);
    own.install([open(A, 2)]);
    expect(await read(own, "k1")).toBe("third");
  });

  it("returns a key whose only records are dropped to the runs", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("k1", "own"), del("k2")]);
    own.add(A, 2, [put("k1", "own again")]);
    own.install([open(A, 2)]);
    expect(own.get(k("k1"))).toBeUndefined();
    expect(own.get(k("k2"))).toBeUndefined();
    expect(await read(own, "k1")).toBe("run-k1");
    expect(await read(own, "k2")).toBe("run-k2");
    expect(own.range()).toEqual([]);
  });

  it("drops everything of a final log, past its n too", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("z", "3")]);
    own.add(B, 1, [put("w", "1")]);
    own.install([final(A, 1)]);
    expect(own.range().map((r) => dec.decode(r.key))).toEqual(["w"]);
    expect(own.above(A, 0)).toEqual([]);
  });

  it("keeps the records past a damaged cursor, and above returns them in order", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.add(A, 3, [put("x", "3"), del("y")]);
    own.add(A, 4, [put("z", "4")]);
    own.install([damaged(A, 2)]);
    expect(await read(own, "x")).toBe("3");
    expect(await read(own, "z")).toBe("4");
    const rest = own.above(A, 2);
    expect(rest.map((r) => r.n)).toEqual([3, 4]);
    expect(rest[0]!.ops).toEqual([put("x", "3"), del("y")]);
    expect(own.above(A, 3).map((r) => r.n)).toEqual([4]);
  });

  it("reads an older log's kept write of a key after the newer log's write of it is dropped", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("z", "a1")]);
    own.add(A, 2, [put("x", "a2")]);
    own.add(B, 1, [put("x", "b1")]);
    own.add(B, 2, [put("w", "b2")]);
    own.install([damaged(A, 1), open(B, 1)]);
    expect(await read(own, "x")).toBe("a2");
    expect(own.get(k("z"))).toBeUndefined();
    expect(await read(own, "w")).toBe("b2");
  });

  it("rebuilds with a newer log's write over an older log's kept write of the same key", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("z", "a1")]);
    own.add(A, 2, [put("x", "a2")]);
    own.add(B, 1, [put("x", "b1")]);
    own.install([damaged(A, 1)]);
    expect(await read(own, "x")).toBe("b1");
    expect(own.get(k("z"))).toBeUndefined();
  });

  it("drops what retire names and nothing of another log", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "a")]);
    own.add(B, 1, [put("y", "b")]);
    own.install([damaged(A, 0)]);
    own.retire(A);
    expect(own.get(k("x"))).toBeUndefined();
    expect(await read(own, "y")).toBe("b");
    expect(own.above(A, 0)).toEqual([]);
    own.retire("never-added" as LogId);
    expect(await read(own, "y")).toBe("b");
  });

  it("ignores cursors of logs it never held and cursors that move back", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.install([open("other" as LogId, 9), final("gone" as LogId, 3)]);
    expect(own.range()).toHaveLength(2);
    own.install([open(A, 1)]);
    own.install([open(A, 0)]);
    expect(own.get(k("x"))).toBeUndefined();
    expect(await read(own, "y")).toBe("2");
    own.add(A, 1, [put("x", "again")]);
    expect(own.get(k("x"))).toBeUndefined();
    own.install([]);
    expect(await read(own, "y")).toBe("2");
  });
});

describe("OwnQueue add", () => {
  it("ignores a record the installed manifest already covers", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.add(A, 2, [put("y", "2")]);
    own.install([open(A, 2)]);
    own.add(A, 2, [put("late", "2")]);
    expect(own.get(k("late"))).toBeUndefined();
    expect(own.bytes).toBe(0);
    own.add(A, 3, [put("z", "3")]);
    expect(own.get(k("z"))).toBeDefined();
  });

  it("ignores a record of a retired or final log", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1")]);
    own.install([final(A, 1)]);
    own.add(A, 2, [put("y", "2")]);
    expect(own.range()).toEqual([]);
  });

  it("refuses a gap, a restart, and a record for a log a newer one replaced", () => {
    const own = new OwnQueue();
    expect(() => own.add(A, 2, [put("x", "1")])).toThrow(RangeError);
    own.add(A, 1, [put("x", "1")]);
    expect(() => own.add(A, 3, [put("x", "3")])).toThrow(RangeError);
    own.add(B, 1, [put("y", "1")]);
    expect(() => own.add(A, 2, [put("x", "2")])).toThrow(RangeError);
    expect(own.range()).toHaveLength(2);
  });

  it("counts the key and value bytes it holds", () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("key", "value"), del("gone")]);
    own.add(A, 2, [put("k", "v")]);
    own.add(B, 1, [put("b", "bb")]);
    expect(own.bytes).toBe(3 + 5 + 4 + 2 + 3);
    own.install([open(A, 1)]);
    expect(own.bytes).toBe(2 + 3);
    own.retire(B);
    expect(own.bytes).toBe(2);
    own.install([final(A, 2)]);
    expect(own.bytes).toBe(0);
  });
});

describe("OwnQueue pin", () => {
  it("keeps answering as it did when pinned through add, install and retire", async () => {
    const own = new OwnQueue();
    own.add(A, 1, [put("x", "1"), put("k2", "own")]);
    own.add(A, 2, [del("k3")]);
    const pinned = own.pin();
    const before = await scan(pinned);
    expect(before).toEqual(["k1=run-k1", "k2=own", "k4=run-k4", "x=1"]);

    own.add(A, 3, [put("x", "3"), put("new", "n")]);
    own.install([open(A, 2)]);
    own.add(B, 1, [put("y", "1")]);
    own.retire(B);

    expect(await scan(pinned)).toEqual(before);
    expect(await read(pinned, "x")).toBe("1");
    expect(await read(pinned, "new")).toBeUndefined();
    expect(await read(pinned, "k3")).toBeUndefined();
    expect(await scan(own)).toEqual(["k1=run-k1", "k2=run-k2", "k3=run-k3", "k4=run-k4", "new=n", "x=3"]);
  });

  it("holds a large overlay across an install that rebuilds it", async () => {
    const own = new OwnQueue();
    const name = (i: number) => `n${String(i).padStart(5, "0")}`;
    for (let n = 1; n <= 30; n++) {
      own.add(A, n, Array.from({ length: 100 }, (_, i) => put(name((n - 1) * 100 + i), `a${n}`)));
    }
    const pinned = own.pin();
    const want = pinned.range().map((r) => dec.decode(r.key));
    expect(want).toHaveLength(3000);

    own.install([open(A, 20)]);
    own.add(A, 31, [put(name(0), "again"), put(name(5000), "tail")]);
    own.retire(A);

    expect(pinned.range().map((r) => dec.decode(r.key))).toEqual(want);
    expect(dec.decode(pinned.get(k(name(0)))!.value!)).toBe("a1");
    expect(own.range()).toEqual([]);
  });
});

type Row = { readonly kind: "put" | "del"; readonly value?: string };

/** The naive model: every record ever added, replayed in order, minus what the latest cursors and retires cover. */
class Model {
  private readonly records: { log: LogId; n: number; ops: CheckedOp[] }[] = [];
  private cursors: readonly QueueCursor[] = [];
  private readonly retired = new Set<LogId>();

  add(log: LogId, n: number, ops: CheckedOp[]): void {
    this.records.push({ log, n, ops });
  }

  install(cursors: readonly QueueCursor[]): void {
    this.cursors = cursors;
  }

  retire(log: LogId): void {
    this.retired.add(log);
  }

  survivors(log?: LogId) {
    return this.records.filter((r) => {
      if ((log !== undefined && r.log !== log) || this.retired.has(r.log)) return false;
      const c = this.cursors.find((x) => x.log === r.log);
      return !c || (c.state !== "final" && r.n > c.n);
    });
  }

  bytes(): number {
    let total = 0;
    for (const r of this.survivors()) {
      for (const op of r.ops) total += op.key.byteLength + (op.type === "put" ? op.value.byteLength : 0);
    }
    return total;
  }

  overlay(): Map<string, Row> {
    const rows = new Map<string, Row>();
    for (const r of this.survivors()) {
      for (const op of r.ops) {
        rows.set(dec.decode(op.key), op.type === "put" ? { kind: "put", value: dec.decode(op.value) } : { kind: "del" });
      }
    }
    return rows;
  }

  /** The runs, then the overlay on top. */
  state(): Map<string, string> {
    const out = new Map(["k1", "k2", "k3", "k4"].map((key) => [key, `run-${key}`]));
    for (const [key, row] of this.overlay()) {
      if (row.kind === "put") out.set(key, row.value!);
      else out.delete(key);
    }
    return out;
  }
}

type Snapshot = { readonly overlay: Map<string, Row>; readonly state: Map<string, string> };

const KEYS = Array.from({ length: 8 }, (_, i) => `k${i}`);
const RANGES: { start?: string; endExclusive?: string; reverse?: boolean; limit?: number }[] = [
  {},
  { reverse: true },
  { start: "k2", endExclusive: "k6" },
  { start: "k2", endExclusive: "k6", reverse: true },
  { start: "k3" },
  { endExclusive: "k4", reverse: true, limit: 2 },
  { start: "k1", limit: 3 },
];

async function expectReads(rows: MemRows, want: Snapshot): Promise<void> {
  for (const key of KEYS) {
    const row = rows.get(k(key));
    expect(row && { kind: row.kind, value: row.value && dec.decode(row.value) }).toEqual(want.overlay.get(key));
    expect(await read(rows, key)).toBe(want.state.get(key));
  }
  for (const r of RANGES) {
    const range: Range = {
      ...(r.start !== undefined && { start: k(r.start) }),
      ...(r.endExclusive !== undefined && { endExclusive: k(r.endExclusive) }),
      ...(r.reverse && { reverse: true }),
      ...(r.limit !== undefined && { limit: r.limit }),
    };
    const inside = (key: string) => (r.start === undefined || key >= r.start) && (r.endExclusive === undefined || key < r.endExclusive);
    const ordered = [...want.state].filter(([key]) => inside(key)).sort(([a], [b]) => (a < b ? -1 : 1));
    if (r.reverse) ordered.reverse();
    expect(await scan(rows, range)).toEqual(ordered.slice(0, r.limit).map(([key, value]) => `${key}=${value}`));

    const bounds = boundsOf(range);
    const overlay = [...want.overlay].filter(([key]) => inside(key)).sort(([a], [b]) => (a < b ? -1 : 1));
    expect(rows.range(bounds).map((row) => [dec.decode(row.key), row.kind, row.value && dec.decode(row.value)])).toEqual(
      overlay.map(([key, row]) => [key, row.kind, row.value]),
    );
  }
}

type Move = { log: number; to: number; kind: "open" | "final" | "damaged" };
type Step =
  | { t: "add"; ops: { del: boolean; key: number }[] }
  | { t: "newLog" }
  | { t: "install"; moves: Move[] }
  | { t: "retire"; log: number }
  | { t: "pin" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("add" as const),
      ops: fc.array(fc.record({ del: fc.boolean(), key: fc.integer({ min: 0, max: 7 }) }), { maxLength: 4 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("newLog" as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("install" as const),
      moves: fc.array(
        fc.record({
          log: fc.nat(3),
          to: fc.integer({ min: 0, max: 100 }),
          kind: fc.constantFrom("open" as const, "open" as const, "open" as const, "final" as const, "damaged" as const),
        }),
        { maxLength: 3 },
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("retire" as const), log: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("pin" as const) }) },
);

async function replay(steps: readonly Step[]): Promise<void> {
  const own = new OwnQueue();
  const model = new Model();
  const logs: LogId[] = [];
  const added = new Map<LogId, number>();
  const cursors = new Map<LogId, QueueCursor>();
  const pins: { rows: MemRows; want: Snapshot }[] = [];
  let counter = 0;

  for (const step of steps) {
    if (step.t === "newLog") logs.push(`log${logs.length}` as LogId);
    else if (step.t === "add") {
      if (logs.length === 0) logs.push("log0" as LogId);
      const log = logs[logs.length - 1]!;
      const n = (added.get(log) ?? 0) + 1;
      added.set(log, n);
      counter += 1;
      const ops = step.ops.map((o) => (o.del ? del(`k${o.key}`) : put(`k${o.key}`, `v${counter}`)));
      own.add(log, n, ops);
      model.add(log, n, ops);
    } else if (step.t === "install") {
      for (const m of step.moves) {
        const i = m.log % (logs.length + 1);
        const log = i < logs.length ? logs[i]! : ("alien" as LogId);
        const held = i < logs.length ? added.get(log) : 5;
        const prev = cursors.get(log);
        if (held === undefined || (prev && prev.state !== "open")) continue;
        const n = Math.max(prev?.n ?? 0, Math.floor((held * m.to) / 100));
        cursors.set(log, m.kind === "open" ? open(log, n) : m.kind === "final" ? final(log, n) : damaged(log, n));
      }
      own.install([...cursors.values()]);
      model.install([...cursors.values()]);
    } else if (step.t === "retire") {
      const log = logs[step.log % Math.max(logs.length, 1)];
      if (log && added.has(log)) {
        own.retire(log);
        model.retire(log);
      }
    } else if (pins.length < 6) {
      pins.push({ rows: own.pin(), want: { overlay: model.overlay(), state: model.state() } });
    }

    await expectReads(own, { overlay: model.overlay(), state: model.state() });
    expect(own.bytes).toBe(model.bytes());
    for (const log of logs) {
      for (const after of [0, Math.floor((added.get(log) ?? 0) / 2), added.get(log) ?? 0]) {
        const want = model.survivors(log).filter((r) => r.n > after);
        const got = own.above(log, after);
        expect(got.map((r) => r.n)).toEqual(want.map((r) => r.n));
        expect(got.map((r) => r.ops)).toEqual(want.map((r) => r.ops));
      }
    }
    for (const pin of pins) await expectReads(pin.rows, pin.want);
  }
}

describe("OwnQueue against a naive model", () => {
  it("agrees on get, range, reverse range, above and bytes through add, install, retire and pin", async () => {
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 60, size: "max" }), replay), {
      numRuns: Number(process.env.KV_MODEL_RUNS ?? 100),
      ...(process.env.KV_MODEL_SEED ? { seed: Number(process.env.KV_MODEL_SEED) } : {}),
    });
  }, 120_000);
});
