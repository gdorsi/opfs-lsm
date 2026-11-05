import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import { Memtable, type MemRow, type MemRows } from "../src/store/memtable.js";

const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`) as CheckedKey;

function sorted(model: Map<number, MemRow>): MemRow[] {
  return [...model.values()].sort((a, b) => compareBytes(a.key, b.key));
}

function seqs(rows: readonly MemRow[]): number[] {
  return rows.map((r) => r.seq);
}

describe("Memtable", () => {
  it("counts the op bytes of records above ingestedThrough, overwrites and deletes included", () => {
    const mem = new Memtable();
    const k = new TextEncoder().encode("key") as CheckedKey;
    const v = new Uint8Array(7) as CheckedValue;
    const put: CheckedOp = { type: "put", key: k, value: v };
    const del: CheckedOp = { type: "del", key: k };
    mem.apply({ seq: 1, ops: [put] });
    mem.apply({ seq: 2, ops: [put, put] });
    mem.apply({ seq: 3, ops: [del] });
    expect(mem.walBytes).toBe(10 + 20 + 3);
    mem.advanceTo(2);
    expect(mem.walBytes).toBe(3);
    mem.advanceTo(5);
    expect(mem.walBytes).toBe(0);
    mem.apply({ seq: 6, ops: [put] });
    expect(mem.walBytes).toBe(10);
  });

  it("matches a sorted map through writes, pins, and drops", () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const mem = new Memtable();
    const model = new Map<number, MemRow>();
    const pins: { rows: MemRows; want: MemRow[] }[] = [];
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
        expect(mem.apply({ seq, ops })).toBe(true);
      } else if (roll < 92) {
        pins.push({ rows: mem.pin(), want: sorted(model) });
      } else if (roll < 95) {
        const through = seq - rand(50);
        mem.advanceTo(through);
        for (const [k, row] of model) if (row.seq <= through) model.delete(k);
      } else {
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
    expect(pins.length).toBeGreaterThan(100);
    for (const pin of pins) {
      expect(seqs(pin.rows.range())).toEqual(seqs(pin.want));
      const probe = pin.want[pin.want.length >> 1];
      if (probe) expect(pin.rows.get(probe.key)?.seq).toBe(probe.seq);
    }
  });
});
