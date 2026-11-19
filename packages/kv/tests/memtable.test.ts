import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import { asSeq } from "../src/seq.js";
import type { ScanBounds } from "../src/store/cursor.js";
import { Memtable, type MemRow, type MemRows } from "../src/store/memtable.js";

const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`) as CheckedKey;

function sorted(model: Map<number, MemRow>): MemRow[] {
  return [...model.values()].sort((a, b) => compareBytes(a.key, b.key));
}

function seqs(rows: readonly MemRow[]): number[] {
  return rows.map((r) => r.seq);
}

/** What a table with one empty-valued row says a row costs besides its key and value. */
function rowOverhead(): number {
  const mem = new Memtable();
  mem.apply({ seq: 1, ops: [{ type: "put", key: enc.encode("k") as CheckedKey, value: new Uint8Array(0) as CheckedValue }] });
  return mem.bytes - 1;
}

describe("Memtable", () => {
  it("matches a sorted map through writes, pins, and drops", () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const mem = new Memtable();
    const model = new Map<number, MemRow>();
    const pins: { rows: MemRows; want: MemRow[] }[] = [];
    const overhead = rowOverhead();
    const modelBytes = () =>
      [...model.values()].reduce((n, r) => n + overhead + r.key.byteLength + (r.value?.byteLength ?? 0), 0);
    let seq = 0;
    for (let step = 0; step < 4000; step++) {
      const roll = rand(100);
      if (roll < 85) {
        const ops: CheckedOp[] = [];
        seq += 1;
        for (let n = 1 + rand(40); n > 0; n--) {
          const k = rand(6000);
          const key = keyOf(k);
          const del = rand(10) === 0;
          ops.push(del ? { type: "del", key } : { type: "put", key, value: enc.encode(`v${seq}`) as CheckedValue });
          model.set(k, del ? { key, seq, kind: "del" } : { key, seq, kind: "put", value: enc.encode(`v${seq}`) });
        }
        expect(mem.apply({ seq, ops })).toBe("applied");
      } else if (roll < 92) {
        pins.push({ rows: mem.pin(), want: sorted(model) });
      } else if (roll < 95) {
        const through = seq - rand(50);
        mem.advanceTo(through);
        for (const [k, row] of model) if (row.seq <= through) model.delete(k);
      } else {
        expect(mem.bytes).toBe(modelBytes());
        const k = rand(6000);
        expect(mem.get(keyOf(k))?.seq).toBe(model.get(k)?.seq);
        const lo = rand(6000);
        const bounds = { start: keyOf(lo), endExclusive: keyOf(lo + rand(300)) };
        const want = sorted(model).filter(
          (r) => compareBytes(r.key, bounds.start) >= 0 && compareBytes(r.key, bounds.endExclusive) < 0,
        );
        expect(seqs(mem.range(bounds))).toEqual(seqs(want));
      }
    }
    expect(seqs(mem.range())).toEqual(seqs(sorted(model)));
    expect(mem.bytes).toBe(modelBytes());
    expect(pins.length).toBeGreaterThan(100);
    for (const pin of pins) {
      expect(seqs(pin.rows.range())).toEqual(seqs(pin.want));
      const probe = pin.want[pin.want.length >> 1];
      if (probe) expect(pin.rows.get(probe.key)?.seq).toBe(probe.seq);
    }
  });

  it("counts the key, value and a fixed overhead of every live row", () => {
    const put = (key: string, value: string): CheckedOp => ({
      type: "put",
      key: enc.encode(key) as CheckedKey,
      value: enc.encode(value) as CheckedValue,
    });
    const overhead = rowOverhead();
    const rows = (...sizes: [key: number, value: number][]) =>
      sizes.reduce((n, [key, value]) => n + overhead + key + value, 0);
    const mem = new Memtable();
    expect(mem.bytes).toBe(0);

    mem.apply({ seq: 1, ops: [put("a", "1234"), put("b", "12")] });
    expect(mem.bytes).toBe(rows([1, 4], [1, 2]));

    // An overwrite swaps the row's bytes for the new row's, even while a pin holds the old one.
    const pin = mem.pin();
    mem.apply({ seq: 2, ops: [put("a", "123456789")] });
    expect(mem.bytes).toBe(rows([1, 9], [1, 2]));
    expect(pin.get(enc.encode("a"))?.value?.byteLength).toBe(4);

    // A delete keeps the key and drops the value.
    mem.apply({ seq: 3, ops: [{ type: "del", key: enc.encode("b") as CheckedKey }] });
    expect(mem.bytes).toBe(rows([1, 9], [1, 0]));

    // Rows the installed generation covers leave.
    mem.advanceTo(2);
    expect(mem.bytes).toBe(rows([1, 0]));
    mem.advanceTo(3);
    expect(mem.bytes).toBe(0);
  });
});

// One 40-byte stem, cut at lengths that nest, so keys share long prefixes, end inside one another's prefix, or are empty.
const STEM = Uint8Array.from({ length: 40 }, (_, i) => 0x60 + (i % 7));
const stemArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(30, 40) },
  { weight: 2, arbitrary: fc.constantFrom(0, 1, 2, 5, 6, 7, 12, 13) },
);
// Zero and 0xff tails: a key and the same key with zeros after it differ only in length, and nine bytes outlast what a search compares first.
const tailArb = fc.array(fc.constantFrom(0x00, 0x01, 0xff), { maxLength: 9 });
// A changed stem byte puts a key before or after every key that kept the stem.
const bendArb = fc.option(fc.tuple(fc.nat(39), fc.constantFrom(0x00, 0x5f, 0x68, 0xff)), { nil: undefined, freq: 8 });
const keyArb = fc.tuple(stemArb, tailArb, bendArb).map(([stem, tail, bend]) => {
  const key = Uint8Array.from([...STEM.subarray(0, stem), ...tail]);
  if (bend && bend[0] < stem) key[bend[0]] = bend[1];
  return key as CheckedKey;
});
const valueArb = fc.uint8Array({ maxLength: 4 }).map((b) => b as CheckedValue);
const boundsArb = fc.tuple(fc.option(keyArb, { nil: undefined }), fc.option(keyArb, { nil: undefined })).map(([a, b]): ScanBounds => {
  const [start, end] = a && b && compareBytes(b, a) < 0 ? [b, a] : [a, b];
  return { ...(start ? { start } : {}), ...(end ? { endExclusive: end } : {}) };
});

type Draft =
  | { type: "put"; key: CheckedKey; value: CheckedValue }
  | { type: "del"; key: CheckedKey }
  | { type: "deleteRange"; bounds: ScanBounds; back: number };

/** One range delete per `writesPerRangeDelete` writes: each one rebuilds the table, and a table rebuilt too often never splits a chunk. */
function draftArb(writesPerRangeDelete: number): fc.Arbitrary<Draft> {
  return fc.oneof(
    { weight: writesPerRangeDelete * 0.875, arbitrary: fc.record({ type: fc.constant("put" as const), key: keyArb, value: valueArb }) },
    { weight: writesPerRangeDelete * 0.125, arbitrary: fc.record({ type: fc.constant("del" as const), key: keyArb }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant("deleteRange" as const), bounds: boundsArb, back: fc.nat(6) }) },
  );
}

type Command =
  | { type: "apply"; drafts: Draft[]; at: "next" | "stale" | "gap" }
  | { type: "pin" }
  | { type: "advance"; back: number }
  | { type: "read"; pin: number; keys: CheckedKey[]; bounds: ScanBounds };

// `size: "max"` because fast-check otherwise keeps an array near ten items whatever its maxLength.
function commandArb(opsPerRecord: number, writesPerRangeDelete: number): fc.Arbitrary<Command> {
  return fc.oneof(
    {
      weight: 12,
      arbitrary: fc.record({
        type: fc.constant("apply" as const),
        drafts: fc.array(draftArb(writesPerRangeDelete), { maxLength: opsPerRecord, size: "max" }),
        at: fc.oneof({ weight: 12, arbitrary: fc.constant("next" as const) }, { weight: 1, arbitrary: fc.constantFrom("stale" as const, "gap" as const) }),
      }),
    },
    { weight: 2, arbitrary: fc.record({ type: fc.constant("pin" as const) }) },
    // Below zero the installed generation is ahead of the table, which then drops every row.
    { weight: 1, arbitrary: fc.record({ type: fc.constant("advance" as const), back: fc.integer({ min: -2, max: 8 }) }) },
    {
      weight: 6,
      arbitrary: fc.record({ type: fc.constant("read" as const), pin: fc.nat(), keys: fc.array(keyArb, { maxLength: 8 }), bounds: boundsArb }),
    },
  );
}

type ModelRow = { key: Uint8Array; seq: number; kind: "put" | "del"; value?: Uint8Array };
const nameOf = (key: Uint8Array) => key.join(",");
const inBounds = (key: Uint8Array, b: ScanBounds) =>
  (!b.start || compareBytes(key, b.start) >= 0) && (!b.endExclusive || compareBytes(key, b.endExclusive) < 0);
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined || b === undefined ? a === b : compareBytes(a, b) === 0;

/** Fails with the first row that differs, which a `toEqual` diff of thousands of rows buries. */
function expectRows(got: readonly (MemRow | undefined)[], want: readonly (ModelRow | undefined)[], what: string): void {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const g = got[i];
    const w = want[i];
    if (g?.seq === w?.seq && g?.kind === w?.kind && sameBytes(g?.key, w?.key) && sameBytes(g?.value, w?.value)) continue;
    const show = (r: MemRow | ModelRow | undefined) => (r ? `${r.kind} [${r.key}] at seq ${r.seq}` : "no row");
    throw new Error(`${what}, row ${i} of ${want.length}: got ${show(g)}, want ${show(w)}`);
  }
}

/** Runs `commands` on a Memtable and on a map of rows sorted on demand, and compares every read. Returns the most rows the table held. */
function runAgainstModel(commands: readonly Command[], overhead: number): number {
  const mem = new Memtable();
  let model = new Map<string, ModelRow>();
  let applied = 0;
  let ingested = 0;
  const pins: { rows: MemRows; want: ModelRow[] }[] = [];
  let most = 0;
  const sorted = () => [...model.values()].sort((a, b) => compareBytes(a.key, b.key));

  const check = (rows: MemRows, want: readonly ModelRow[], keys: readonly Uint8Array[], bounds: ScanBounds, what: string) => {
    const byName = new Map(want.map((r) => [nameOf(r.key), r]));
    for (const key of keys) expectRows([rows.get(key)], [byName.get(nameOf(key))], `${what} get [${key}]`);
    expectRows(
      rows.range(bounds),
      want.filter((r) => inBounds(r.key, bounds)),
      `${what} range`,
    );
  };

  for (const cmd of commands) {
    if (cmd.type === "apply") {
      const seq = cmd.at === "next" ? applied + 1 : cmd.at === "gap" ? applied + 2 : applied;
      const ops: CheckedOp[] = cmd.drafts.map((d) =>
        d.type === "deleteRange"
          ? {
              type: "deleteRange",
              start: (d.bounds.start ?? new Uint8Array(0)) as CheckedKey,
              ...(d.bounds.endExclusive ? { endExclusive: d.bounds.endExclusive as CheckedKey } : {}),
              through: asSeq(Math.max(0, seq - 1 - d.back)),
            }
          : d,
      );
      expect(mem.apply({ seq: asSeq(seq), ops })).toBe(cmd.at === "next" ? "applied" : cmd.at === "gap" ? "gap" : "already");
      if (cmd.at !== "next") continue;
      applied = seq;
      for (const op of ops) {
        if (op.type === "put") model.set(nameOf(op.key), { key: op.key, seq, kind: "put", value: op.value });
        else if (op.type === "del") model.set(nameOf(op.key), { key: op.key, seq, kind: "del" });
        else {
          const bounds = { start: op.start, ...(op.endExclusive ? { endExclusive: op.endExclusive } : {}) };
          for (const [name, row] of model) if (row.seq <= op.through && inBounds(row.key, bounds)) model.delete(name);
        }
      }
    } else if (cmd.type === "pin") {
      pins.push({ rows: mem.pin(), want: sorted() });
    } else if (cmd.type === "advance") {
      const through = applied - cmd.back;
      expect(mem.advanceTo(asSeq(through))).toBe(through > ingested && through > applied);
      if (through <= ingested) continue;
      ingested = through;
      applied = Math.max(applied, through);
      model = new Map([...model].filter(([, row]) => row.seq > through));
    } else {
      check(mem, sorted(), cmd.keys, cmd.bounds, "live");
      const pin = pins[cmd.pin % (pins.length + 1)];
      if (pin) check(pin.rows, pin.want, cmd.keys, cmd.bounds, "pin");
    }
    expect(mem.appliedThrough).toBe(applied);
    most = Math.max(most, model.size);
  }

  const rows = sorted();
  expectRows(mem.range(), rows, "live range at the end");
  expect(mem.bytes).toBe(rows.reduce((n, r) => n + overhead + r.key.byteLength + (r.value?.byteLength ?? 0), 0));
  expectRows(
    rows.map((r) => mem.get(r.key)),
    rows,
    "live get of every row",
  );
  for (const pin of pins) {
    expectRows(pin.rows.range(), pin.want, "pin range at the end");
    expectRows(
      pin.want.map((r) => pin.rows.get(r.key)),
      pin.want,
      "pin get of every row",
    );
  }
  return most;
}

describe("Memtable against a sorted map", () => {
  const overhead = rowOverhead();

  /** Runs random histories. Returns the most rows any of them held, so a test can tell its tables grew. */
  function histories(opsPerRecord: number, writesPerRangeDelete: number, length: { minLength?: number; maxLength: number }, numRuns: number): number {
    let most = 0;
    fc.assert(
      fc.property(fc.array(commandArb(opsPerRecord, writesPerRangeDelete), { ...length, size: "max" }), (commands) => {
        most = Math.max(most, runAgainstModel(commands, overhead));
      }),
      // No shrinking: a failure needs a few hundred rows, and shrinking that many takes minutes. The seed and path fast-check prints replay it.
      { numRuns, endOnFailure: true },
    );
    return most;
  }

  it("reads the same through writes, range deletes, pins and drops on tables of hundreds of rows", () => {
    expect(histories(40, 200, { maxLength: 60 }, 500)).toBeGreaterThan(300);
  });

  it("reads the same on tables of thousands of rows", () => {
    expect(histories(600, 4000, { minLength: 20, maxLength: 40 }, 40)).toBeGreaterThan(2000);
  });
});
