import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import { asSeq } from "../src/seq.js";
import { foldRecords } from "../src/store/fold.js";
import type { WalRecord } from "../src/store/memtable.js";

const key = (...bytes: number[]) => new Uint8Array(bytes) as CheckedKey;
const value = (...bytes: number[]) => new Uint8Array(bytes) as CheckedValue;

// Short keys over a tiny alphabet make duplicates, shared prefixes and prefix pairs common.
const keyArb = fc.uint8Array({ minLength: 0, maxLength: 3, max: 3 }).map((b) => b as CheckedKey);
const valueArb = fc.uint8Array({ maxLength: 3 }).map((b) => b as CheckedValue);
const SEQS = 12;

type Draft =
  | { type: "put"; key: CheckedKey; value: CheckedValue }
  | { type: "del"; key: CheckedKey }
  | { type: "deleteRange"; start: CheckedKey; end: CheckedKey | undefined; through: number };

const draftArb: fc.Arbitrary<Draft> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant("put" as const), key: keyArb, value: valueArb }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("del" as const), key: keyArb }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("deleteRange" as const),
      start: keyArb,
      end: fc.option(keyArb, { nil: undefined }),
      through: fc.integer({ min: 0, max: SEQS }),
    }),
  },
);

/** Consecutive seqs from 1. A range delete's `through` is clamped below its record's seq. */
function toRecords(batches: Draft[][]): WalRecord[] {
  return batches.map((drafts, i) => {
    const seq = i + 1;
    const ops: CheckedOp[] = drafts.map((d) => {
      if (d.type !== "deleteRange") return d;
      const [start, end] = d.end && compareBytes(d.end, d.start) < 0 ? [d.end, d.start] : [d.start, d.end];
      return {
        type: "deleteRange",
        start,
        ...(end && compareBytes(start, end) < 0 ? { endExclusive: end } : {}),
        through: asSeq(Math.min(d.through, seq - 1)),
      };
    });
    return { seq: asSeq(seq), ops };
  });
}

/** What a reader of the fold sees, by hand: replay every op, then apply every mark. */
function reference(records: readonly WalRecord[]) {
  const latest = new Map<string, { key: Uint8Array; kind: "put" | "del"; value?: number[]; seq: number }>();
  const marks: { start: number[]; end?: number[]; through: number; at: number }[] = [];
  for (const rec of records) {
    for (const op of rec.ops) {
      if (op.type === "deleteRange") {
        if (op.through > 0) {
          marks.push({
            start: [...op.start],
            ...(op.endExclusive ? { end: [...op.endExclusive] } : {}),
            through: op.through,
            at: rec.seq,
          });
        }
      } else {
        latest.set(op.key.join(","), {
          key: op.key,
          kind: op.type,
          ...(op.type === "put" ? { value: [...op.value] } : {}),
          seq: rec.seq,
        });
      }
    }
  }
  const covered = (k: Uint8Array, seq: number) =>
    marks.some(
      (m) =>
        seq <= m.through &&
        compareBytes(k, new Uint8Array(m.start)) >= 0 &&
        (!m.end || compareBytes(k, new Uint8Array(m.end)) < 0),
    );
  const entries = [...latest.values()]
    .filter((e) => !covered(e.key, e.seq))
    .sort((a, b) => compareBytes(a.key, b.key))
    .map((e) => ({ kind: e.kind, key: [...e.key], ...(e.value ? { value: e.value } : {}), seq: e.seq }));
  return { entries, marks };
}

function observed(records: readonly WalRecord[]) {
  const folded = foldRecords(records);
  return {
    entries: folded.entries.map((e) => ({
      kind: e.kind,
      key: [...e.key],
      ...(e.kind === "put" ? { value: [...e.value] } : {}),
      seq: e.seq,
    })),
    marks: folded.marks.map((m) => ({
      start: [...m.start],
      ...(m.endExclusive ? { end: [...m.endExclusive] } : {}),
      through: m.through,
      at: m.at,
    })),
  };
}

describe("foldRecords", () => {
  it("matches a replay of every op under every mark", () => {
    fc.assert(
      fc.property(fc.array(fc.array(draftArb, { maxLength: 6 }), { maxLength: SEQS }), (batches) => {
        const records = toRecords(batches);
        expect(observed(records)).toEqual(reference(records));
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the later of two writes to a key in one record", () => {
    const records: WalRecord[] = [
      {
        seq: asSeq(1),
        ops: [
          { type: "put", key: key(1), value: value(1) },
          { type: "del", key: key(1) },
          { type: "put", key: key(1), value: value(2) },
        ],
      },
    ];
    expect(observed(records).entries).toEqual([{ kind: "put", key: [1], value: [2], seq: 1 }]);
  });

  it("tells keys apart that differ in length or in a high byte", () => {
    const keys = [key(), key(0), key(0, 0), key(255), key(255, 255), key(128), key(0x80, 0x01)];
    const records: WalRecord[] = keys.map((k, i) => ({
      seq: asSeq(i + 1),
      ops: [{ type: "put", key: k, value: value(i) }],
    }));
    expect(observed(records).entries.map((e) => e.seq)).toEqual([1, 2, 3, 6, 7, 4, 5]);
  });

  it("folds a key longer than one string chunk", () => {
    const long = (last: number) => new Uint8Array(10_000).fill(7).fill(last, 9_999) as CheckedKey;
    const records: WalRecord[] = [1, 2, 3].map((seq) => ({
      seq: asSeq(seq),
      ops: [
        { type: "put", key: long(seq === 3 ? 9 : 8), value: value(seq) },
        { type: "put", key: long(8), value: value(seq) },
      ],
    }));
    const { entries } = observed(records);
    expect(entries.map((e) => [e.key[9_999], e.seq])).toEqual([
      [8, 3],
      [9, 3],
    ]);
  });

  it("tells long keys apart wherever they differ, at the edges of a string chunk and across two lengths", () => {
    const same = (length: number) => new Uint8Array(length).fill(7) as CheckedKey;
    const keys = [same(4_096), same(4_097), same(10_000)];
    for (const at of [0, 1, 4_095, 4_096, 4_097, 8_191, 8_192, 9_999]) keys.push(same(10_000).fill(9, at, at + 1) as CheckedKey);
    // Each key twice, the second time as a copy, so one entry per key with the later seq is the only right answer.
    const records: WalRecord[] = [...keys, ...keys.map((k) => k.slice() as CheckedKey)].map((k, i) => ({
      seq: asSeq(i + 1),
      ops: [{ type: "put", key: k, value: value(i) }],
    }));
    const { entries } = observed(records);
    expect(entries.length).toBe(keys.length);
    for (const e of entries) {
      expect(e.seq).toBe(keys.length + 1 + keys.findIndex((k) => compareBytes(k, e.key) === 0));
    }
  });
});
