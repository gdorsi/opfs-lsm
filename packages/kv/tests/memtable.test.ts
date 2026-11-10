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
