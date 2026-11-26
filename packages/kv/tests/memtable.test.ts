import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { asSeq } from "../src/seq.js";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import { Memtable, type MemRange, type MemRow, type MemRows } from "../src/store/memtable.js";

const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`) as CheckedKey;

function sorted(model: Map<number, MemRow>): MemRow[] {
  return [...model.values()].sort((a, b) => compareBytes(a.key, b.key));
}

/** The rows of `range` in key order, read backward and reversed with `reverse`. */
function rowsOf(range: MemRange, reverse = false): MemRow[] {
  const out: MemRow[] = [];
  const cursor = range.cursor(reverse);
  for (let row = cursor.peek(); row; cursor.next(), row = cursor.peek()) out.push(row as MemRow);
  return reverse ? out.reverse() : out;
}

function seqs(rows: readonly MemRow[] | MemRange): number[] {
  return (Array.isArray(rows) ? rows : rowsOf(rows as MemRange)).map((r) => r.seq);
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
    const ranges: { live: MemRange; want: MemRow[] }[] = [];
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
          if (rand(400) === 0) {
            // A range delete over up to a few chunks, whose `through` may leave newer rows in it.
            const end = k + rand(1500);
            const through = rand(3) === 0 ? rand(seq) : seq - 1;
            ops.push({ type: "deleteRange", start: key, endExclusive: keyOf(end), through: asSeq(through) });
            for (const [i, row] of model) if (i >= k && i < end && row.seq <= through) model.delete(i);
            continue;
          }
          const del = rand(10) === 0;
          ops.push(del ? { type: "del", key } : { type: "put", key, value: enc.encode(`v${seq}`) as CheckedValue });
          model.set(k, del ? { key, seq, kind: "del" } : { key, seq, kind: "put", value: enc.encode(`v${seq}`) });
        }
        expect(mem.apply({ seq, ops })).toBe("applied");
      } else if (roll < 88) {
        pins.push({ rows: mem.pin(), want: sorted(model) });
      } else if (roll < 92) {
        ranges.push({ live: mem.range(), want: sorted(model) });
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
        const range = mem.range(bounds);
        expect(seqs(range)).toEqual(seqs(want));
        expect(seqs(rowsOf(range, true))).toEqual(seqs(want));
        for (const row of want) expect(range.get(row.key)?.seq).toBe(row.seq);
      }
    }
    expect(seqs(mem.range())).toEqual(seqs(sorted(model)));
    expect(mem.bytes).toBe(modelBytes());
    expect(pins.length).toBeGreaterThan(20);
    expect(ranges.length).toBeGreaterThan(20);
    // A range of the live table keeps what it read, as a pin does.
    for (const { live, want } of ranges) expect(seqs(live)).toEqual(seqs(want));
    for (const pin of pins) {
      expect(seqs(pin.rows.range())).toEqual(seqs(pin.want));
      const probe = pin.want[pin.want.length >> 1];
      if (probe) expect(pin.rows.get(probe.key)?.seq).toBe(probe.seq);
    }
  });

  it("finds and orders keys that share long prefixes or are prefixes of each other", () => {
    let seed = 5;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const stems = ["", "a", "collection/00000000/", "collection/00000000/index/", "collection/00000001/"];
    const mem = new Memtable();
    const model = new Map<string, MemRow>();
    const keys: Uint8Array[] = [];
    for (let seq = 1; seq <= 4000; seq++) {
      const tail = Array.from({ length: rand(4) }, () => "ab\u00ff"[rand(3)]).join("") + (rand(3) === 0 ? "" : String(rand(900)));
      const key = Uint8Array.from(stems[rand(stems.length)]! + tail, (c) => c.charCodeAt(0)) as CheckedKey;
      keys.push(key);
      mem.apply({ seq, ops: [{ type: "put", key, value: new Uint8Array(0) as CheckedValue }] });
      model.set(key.join(), { key, seq, kind: "put", value: new Uint8Array(0) });
    }
    const want = sorted(model);
    expect(want.length).toBeGreaterThan(1024);
    expect(seqs(mem.range())).toEqual(seqs(want));
    for (const key of keys) expect(mem.get(key)?.seq).toBe(model.get(key.join())!.seq);
    for (let i = 0; i < 300; i++) {
      const probe = Uint8Array.from([...keys[rand(keys.length)]!, ...(rand(2) ? [rand(256)] : [])]);
      expect(mem.get(probe)?.seq).toBe(model.get(probe.join())?.seq);
      expect(seqs(mem.range({ start: probe }))).toEqual(seqs(want.filter((r) => compareBytes(r.key, probe) >= 0)));
    }
  });

  it("removes the rows a range delete covers across chunks, and a range taken before keeps them", () => {
    let seed = 3;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 12; round++) {
      const mem = new Memtable();
      const model = new Map<number, MemRow>();
      let seq = 0;
      const write = (ops: CheckedOp[]) => expect(mem.apply({ seq: ++seq, ops })).toBe("applied");
      // Several chunks, some rows newer than the range deletes' `through`.
      for (let b = 0; b < 6; b++) {
        const ops: CheckedOp[] = [];
        for (let n = 0; n < 1000; n++) {
          const k = rand(8000);
          ops.push({ type: "put", key: keyOf(k), value: new Uint8Array(0) as CheckedValue });
          model.set(k, { key: keyOf(k), seq: seq + 1, kind: "put", value: new Uint8Array(0) });
        }
        write(ops);
      }
      const taken = [{ live: mem.range(), want: sorted(model) }];
      for (let d = 0; d < 4; d++) {
        const start = rand(3) === 0 ? 0 : rand(8000);
        const end = rand(4) === 0 ? undefined : start + rand(4000);
        const through = rand(6) + 1;
        const op: CheckedOp = {
          type: "deleteRange",
          start: start === 0 ? (new Uint8Array(0) as CheckedKey) : keyOf(start),
          ...(end === undefined ? {} : { endExclusive: keyOf(end) }),
          through: asSeq(through),
        };
        write([op]);
        for (const [i, row] of model) if (i >= start && (end === undefined || i < end) && row.seq <= through) model.delete(i);
        expect(seqs(mem.range())).toEqual(seqs(sorted(model)));
        // A write into the emptied span lands in a chunk the delete kept.
        const k = start + rand(100);
        write([{ type: "put", key: keyOf(k), value: new Uint8Array(0) as CheckedValue }]);
        model.set(k, { key: keyOf(k), seq, kind: "put", value: new Uint8Array(0) });
        expect(seqs(mem.range())).toEqual(seqs(sorted(model)));
        expect(mem.get(keyOf(k))?.seq).toBe(seq);
        taken.push({ live: mem.range(), want: sorted(model) });
      }
      for (const t of taken) expect(seqs(t.live)).toEqual(seqs(t.want));
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

  it("drops the chunks a range delete empties, and a range taken before still reads them", () => {
    const mem = new Memtable();
    const fill: CheckedOp[] = [];
    for (let k = 0; k < 5000; k++) fill.push({ type: "put", key: keyOf(k), value: enc.encode("v") as CheckedValue });
    mem.apply({ seq: asSeq(1), ops: fill });
    const inside = mem as unknown as { chunks: unknown[]; firsts: CheckedKey[] };
    expect(inside.chunks.length).toBeGreaterThan(2);
    const before = mem.range();
    const want = rowsOf(before);
    // From the second chunk to the end: every chunk but the first is emptied.
    mem.apply({ seq: asSeq(2), ops: [{ type: "deleteRange", start: inside.firsts[1]!, through: asSeq(1) }] });
    expect(inside.chunks.length).toBe(1);
    expect(rowsOf(mem.range()).length).toBeGreaterThan(0);
    // The first chunk stays, empty, since its first key is the empty key.
    mem.apply({ seq: asSeq(3), ops: [{ type: "deleteRange", start: new Uint8Array(0) as CheckedKey, through: asSeq(2) }] });
    expect(inside.chunks.length).toBe(1);
    expect(rowsOf(mem.range())).toEqual([]);
    expect(rowsOf(before)).toEqual(want);
    mem.apply({ seq: asSeq(4), ops: [{ type: "put", key: keyOf(4000), value: enc.encode("w") as CheckedValue }] });
    expect(seqs(mem.range())).toEqual([4]);
    expect(mem.get(keyOf(4000))?.seq).toBe(4);
  });

  it("does not share a chunk its range ends at the first key of", () => {
    const mem = new Memtable();
    const fill: CheckedOp[] = [];
    for (let k = 0; k < 3000; k++) fill.push({ type: "put", key: keyOf(k), value: enc.encode("v") as CheckedValue });
    mem.apply({ seq: asSeq(1), ops: fill });
    const inside = mem as unknown as { firsts: Uint8Array[]; owned: boolean[] };
    const range = mem.range({ endExclusive: inside.firsts[1]! });
    expect(rowsOf(range).length).toBeGreaterThan(0);
    expect(inside.owned[0]).toBe(false);
    expect(inside.owned[1]).toBe(true);
  });
});
