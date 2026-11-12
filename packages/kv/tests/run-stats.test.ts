import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { covered, joinMarks, markTable, NO_MARKS, type Mark, type Marks } from "../src/store/marks.js";
import {
  bytesAtOrBelow,
  bytesBelowKey,
  coveredBytes,
  entryBytesThroughSeq,
  expiredBytes,
  liveEntryBytes,
  whollyCovered,
  type RunStats,
} from "../src/store/run-stats.js";
import { encodeRun, type SstEntry } from "../src/store/sst.js";

/** Small blocks, so the half-block term of the key bound stays small next to the run. */
const BLOCK = 128;

const keyArb = fc.uint8Array({ minLength: 1, maxLength: 3, max: 7 });

const entriesArb: fc.Arbitrary<SstEntry[]> = fc
  .array(
    fc.record({
      key: keyArb,
      del: fc.boolean(),
      value: fc.integer({ min: 0, max: 60 }),
      expiresAt: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 300 },
  )
  .chain((rows) => fc.shuffledSubarray(rows.map((_, i) => i + 1), { minLength: rows.length, maxLength: rows.length }).map((seqs) => ({ rows, seqs })))
  .map(({ rows, seqs }) =>
    rows
      .map((r, i): SstEntry => {
        const seq = seqs[i]!;
        if (r.del) return { kind: "del", key: r.key, seq };
        return { kind: "put", key: r.key, value: new Uint8Array(r.value), seq, ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt }) };
      })
      .sort((a, b) => compareBytes(a.key, b.key) || b.seq - a.seq),
  );

const markArb: fc.Arbitrary<Mark> = fc
  .record({ a: fc.uint8Array({ maxLength: 3, max: 7 }), b: fc.option(keyArb, { nil: undefined }), through: fc.integer({ min: 1, max: 300 }) })
  .map(({ a, b, through }) => {
    const [start, end] = b && compareBytes(b, a) < 0 ? [b, a] : [a, b];
    return { start, ...(end ? { endExclusive: end } : {}), through, at: through + 1 };
  });

const marksOf = (list: readonly Mark[]): Marks => list.reduce((acc, m) => joinMarks(acc, markTable(m)), NO_MARKS);

const bytesOf = (e: SstEntry) => e.key.byteLength + (e.kind === "put" ? e.value.byteLength : 0);
const sum = (es: readonly SstEntry[]) => es.reduce((n, e) => n + bytesOf(e), 0);
const statsOf = (entries: readonly SstEntry[]): RunStats => encodeRun(entries, BLOCK).end.stats!;
/** The largest entry bytes a data block can hold: a full block, or one entry past it. */
const blockBound = (entries: readonly SstEntry[]) => Math.max(BLOCK, ...entries.map(bytesOf));

describe("run statistics", () => {
  it("count what the run holds", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const stats = statsOf(entries);
        const dels = entries.filter((e) => e.kind === "del");
        expect(stats.entries).toBe(entries.length);
        expect(stats.entryBytes).toBe(sum(entries));
        expect(stats.tombstones).toBe(dels.length);
        expect(stats.tombstoneBytes).toBe(sum(dels));
      }),
    );
  });

  it("estimate the bytes at or below a seq within 1/16 of the run", () => {
    fc.assert(
      fc.property(entriesArb, fc.integer({ min: -1, max: 302 }), (entries, seq) => {
        const stats = statsOf(entries);
        const exact = sum(entries.filter((e) => e.seq <= seq));
        expect(Math.abs(bytesAtOrBelow(stats.bySeq, seq) - exact)).toBeLessThanOrEqual(stats.entryBytes / 16);
        expect(Math.abs(entryBytesThroughSeq({ runs: [{ stats, marksThrough: 0 }] }, seq) - exact)).toBeLessThanOrEqual(stats.entryBytes / 16);
      }),
    );
  });

  it("estimate the expired bytes at a time within 1/16 of the bytes that expire", () => {
    fc.assert(
      fc.property(entriesArb, fc.integer({ min: 0, max: 101 }), (entries, now) => {
        const stats = statsOf(entries);
        const expiring = entries.filter((e) => e.kind === "put" && e.expiresAt !== undefined);
        const exact = sum(expiring.filter((e) => e.kind === "put" && e.expiresAt! <= now));
        expect(Math.abs(expiredBytes(stats, now) - exact)).toBeLessThanOrEqual(sum(expiring) / 16);
      }),
    );
  });

  it("estimate the bytes below a key within 1/16 of the run plus half a block", () => {
    fc.assert(
      fc.property(entriesArb, fc.uint8Array({ maxLength: 4, max: 8 }), (entries, key) => {
        const stats = statsOf(entries);
        const exact = sum(entries.filter((e) => compareBytes(e.key, key) < 0));
        const bound = stats.entryBytes / 16 + blockBound(entries) / 2;
        expect(Math.abs(bytesBelowKey(stats.byKey, key) - exact)).toBeLessThanOrEqual(bound);
      }),
    );
  });

  it("estimate covered bytes inside the bounds the key and seq estimates allow", () => {
    fc.assert(
      fc.property(entriesArb, fc.array(markArb, { minLength: 1, maxLength: 4 }), (entries, list) => {
        const stats = statsOf(entries);
        const marks = marksOf(list);
        const total = stats.entryBytes;
        const exact = sum(entries.filter((e) => covered(marks, e.key, e.seq)));
        const keySlack = 2 * (total / 16 + blockBound(entries) / 2);
        const seqSlack = total / 16;
        let lo = 0;
        let hi = 0;
        marks.pieces.forEach((piece, i) => {
          if (piece.through === 0) return;
          const end = marks.pieces[i + 1]?.start;
          const inPiece = entries.filter((e) => compareBytes(e.key, piece.start) >= 0 && (!end || compareBytes(e.key, end) < 0));
          const k = sum(inPiece);
          const s = sum(entries.filter((e) => e.seq <= piece.through));
          lo += Math.max(0, k - keySlack + s - seqSlack - total);
          hi += Math.min(k + keySlack, s + seqSlack);
        });
        expect(exact).toBeGreaterThanOrEqual(Math.min(lo, total) - 1e-9);
        expect(exact).toBeLessThanOrEqual(Math.min(hi, total) + 1e-9);
        const estimate = coveredBytes({ stats, marksThrough: 0 }, marks);
        expect(estimate).toBeGreaterThanOrEqual(Math.min(lo, total) - 1e-9);
        expect(estimate).toBeLessThanOrEqual(Math.min(hi, total) + 1e-9);
      }),
    );
  });

  it("estimate covered bytes within 1/16 of the run when the mark holds every key", () => {
    fc.assert(
      fc.property(entriesArb, fc.integer({ min: 1, max: 300 }), (entries, through) => {
        const stats = statsOf(entries);
        const marks = markTable({ start: new Uint8Array(0), through, at: through + 1 });
        const exact = sum(entries.filter((e) => e.seq <= through));
        expect(Math.abs(coveredBytes({ stats, marksThrough: 0 }, marks) - exact)).toBeLessThanOrEqual(stats.entryBytes / 16);
      }),
    );
  });

  it("count no covered bytes for marks the run absorbed", () => {
    fc.assert(
      fc.property(entriesArb, fc.array(markArb, { minLength: 1, maxLength: 4 }), (entries, list) => {
        const marks = marksOf(list);
        const absorbed = Math.max(...marks.pieces.map((p) => p.at));
        expect(coveredBytes({ stats: statsOf(entries), marksThrough: absorbed }, marks)).toBe(0);
      }),
    );
  });

  it("say a run is wholly covered only when every entry is", () => {
    fc.assert(
      fc.property(entriesArb, fc.array(markArb, { maxLength: 4 }), (entries, list) => {
        const marks = marksOf(list);
        expect(!whollyCovered(statsOf(entries), marks) || entries.every((e) => covered(marks, e.key, e.seq))).toBe(true);
      }),
    );
  });

  it("say a run is wholly covered when one mark spans its keys through its largest seq", () => {
    fc.assert(
      fc.property(entriesArb, fc.integer({ min: 0, max: 3 }), (entries, extra) => {
        const maxSeq = Math.max(...entries.map((e) => e.seq));
        const end = new Uint8Array([...entries.at(-1)!.key, 0]);
        const marks = markTable({ start: entries[0]!.key, endExclusive: end, through: maxSeq + extra, at: maxSeq + extra + 1 });
        expect(whollyCovered(statsOf(entries), marks)).toBe(true);
        const short = markTable({ start: entries[0]!.key, endExclusive: end, through: maxSeq - 1, at: maxSeq + 1 });
        expect(whollyCovered(statsOf(entries), short)).toBe(false);
      }),
    );
  });

  it("estimate live bytes, with no marks, within 1/16 of the bytes that expire", () => {
    fc.assert(
      fc.property(fc.array(entriesArb, { minLength: 1, maxLength: 3 }), fc.integer({ min: 0, max: 101 }), (runs, now) => {
        const listed = runs.map((entries) => ({ stats: statsOf(entries), marksThrough: 0 }));
        const all = runs.flat();
        const live = sum(all.filter((e) => e.kind === "put" && (e.expiresAt === undefined || e.expiresAt > now)));
        const expiring = sum(all.filter((e) => e.kind === "put" && e.expiresAt !== undefined));
        expect(Math.abs(liveEntryBytes({ runs: listed, marks: NO_MARKS }, now) - live)).toBeLessThanOrEqual(expiring / 16 + 1e-9);
      }),
    );
  });
});
