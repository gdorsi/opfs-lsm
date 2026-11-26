import { expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { CheckedKey, CheckedValue, ResolvedOp, ResolvedSeq } from "../src/check.js";
import { asSeq } from "../src/seq.js";
import { throughAt, type Mark } from "../src/store/marks.js";
import { Memtable, type MemRange, type MemRow, type MemRows } from "../src/store/memtable.js";

/**
 * The memtable under range deletes, against a model. Bounds sit on stored
 * keys, so a mix-up of the inclusive start and the exclusive end shows, and
 * a `through` falls anywhere below its record.
 */
const key = (i: number) => Uint8Array.of(0x6b, i >> 4, i & 15) as CheckedKey;
const KEYS = 96;
function rowsOf(range: MemRange): MemRow[] {
  const out: MemRow[] = [];
  const cursor = range.cursor();
  for (let row = cursor.peek(); row; cursor.next(), row = cursor.peek()) out.push(row as MemRow);
  return out;
}
const show = (rows: readonly MemRow[] | MemRange) => (Array.isArray(rows) ? rows : rowsOf(rows as MemRange)).map((r) => `${r.key.join(".")}@${r.seq}:${r.kind}`);

function run(seed: number): void {
  let state = seed;
  const rnd = (n: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % n;
  const mem = new Memtable();
  const model = new Map<number, MemRow>();
  let marks: Mark[] = [];
  let seq = 0;
  let ingested = 0;
  const pins: { pin?: MemRows; live?: MemRange; want: string[] }[] = [];
  const rows = () => [...model.values()].sort((a, b) => compareBytes(a.key, b.key));
  const overhead = (() => {
    const one = new Memtable();
    one.apply({ seq: asSeq(1), ops: [{ type: "put", key: key(0), value: new Uint8Array(0) as CheckedValue }] });
    return one.bytes - 3;
  })();

  for (let step = 0; step < 300; step++) {
    const roll = rnd(20);
    if (roll < 13) {
      seq += 1;
      const ops: ResolvedOp[] = [];
      const added: Mark[] = [];
      const written = new Set<number>();
      for (let n = 1 + rnd(8); n > 0; n--) {
        const what = rnd(9);
        const k = rnd(KEYS);
        if (what < 5) {
          const value = new Uint8Array(rnd(200)) as CheckedValue;
          ops.push({ type: "put", key: key(k), value });
          model.set(k, { key: key(k), seq: asSeq(seq), kind: "put", value });
          written.add(k);
        } else if (what < 6) {
          ops.push({ type: "del", key: key(k) });
          model.set(k, { key: key(k), seq: asSeq(seq), kind: "del" });
          written.add(k);
        } else {
          const from = rnd(4) === 0 ? undefined : k;
          const to = rnd(4) === 0 ? undefined : (from ?? 0) + 1 + rnd(KEYS - (from ?? 0));
          const through = (rnd(3) === 0 ? rnd(seq) : seq - 1) as ResolvedSeq;
          const start = from === undefined ? (new Uint8Array(0) as CheckedKey) : key(from);
          const op: ResolvedOp = { type: "deleteRange", start, ...(to === undefined ? {} : { endExclusive: key(to) }), through };
          ops.push(op);
          for (const [i, row] of model) {
            if (row.seq <= through && i >= (from ?? 0) && (to === undefined || i < to)) model.delete(i);
          }
          if (through > 0) added.push({ start, ...(to === undefined ? {} : { endExclusive: key(to) }), through, at: asSeq(seq) });
        }
      }
      expect(mem.apply({ seq: asSeq(seq), ops })).toBe("applied");
      marks = [...marks, ...added];
    } else if (roll < 15) {
      // A pin, or a range of the live table, which keeps what it read the same way.
      pins.push(rnd(2) === 0 ? { pin: mem.pin(), want: show(rows()) } : { live: mem.range(), want: show(rows()) });
    } else if (roll < 16) {
      // The generation a tab installs never passes what it applied by more than a jump, and never goes back.
      const through = Math.max(ingested, seq - rnd(12));
      expect(mem.advanceTo(asSeq(through))).toBe(false);
      ingested = through;
      for (const [i, row] of model) if (row.seq <= through) model.delete(i);
      marks = marks.filter((m) => m.at > through);
    } else if (roll < 18) {
      // A record that is not the next one: an old one, or one past a gap.
      const before = show(mem.range());
      const stale = seq === 0 ? 0 : 1 + rnd(seq);
      // Never applied: a stale or gapped record is refused before its ops are read.
      const ops: ResolvedOp[] = [{ type: "deleteRange", start: new Uint8Array(0) as CheckedKey, through: Number.MAX_SAFE_INTEGER as ResolvedSeq }];
      if (stale > 0) expect(mem.apply({ seq: asSeq(stale), ops })).toBe("already");
      expect(mem.apply({ seq: asSeq(seq + 2 + rnd(3)), ops })).toBe("gap");
      expect(show(mem.range())).toEqual(before);
      expect(mem.appliedThrough).toBe(Math.max(seq, ingested));
    }

    const held = rowsOf(mem.range());
    expect(show(held), `seed ${seed} step ${step}`).toEqual(show(rows()));
    const fields = (m: Mark) => ({ start: m.start, endExclusive: m.endExclusive, through: m.through, at: m.at });
    expect(mem.marks.map(fields), `seed ${seed} step ${step}: marks`).toEqual(marks.map(fields));
    for (const row of held) expect(row.seq, `seed ${seed} step ${step}: ${row.key.join(".")} is covered`).toBeGreaterThan(throughAt(mem.marks, row.key));
    expect(mem.bytes, `seed ${seed} step ${step}: bytes`).toBe(held.reduce((n, r) => n + overhead + r.key.byteLength + (r.value?.byteLength ?? 0), 0));
    if (rnd(4) === 0) {
      const a = rnd(KEYS);
      const b = a + rnd(KEYS - a + 1);
      const bounds = { start: key(a), endExclusive: key(b) };
      const want = rows().filter((r) => compareBytes(r.key, bounds.start) >= 0 && compareBytes(r.key, bounds.endExclusive) < 0);
      expect(show(mem.range(bounds))).toEqual(show(want));
      expect(mem.get(key(a))?.seq).toBe(model.get(a)?.seq);
    }
  }
  for (const { pin, live, want } of pins) expect(show(pin ? pin.range() : live!), `seed ${seed}: reads what it read when taken`).toEqual(want);
}

it("the memtable under range deletes holds the rows a model holds, the marks of what it applied, and no covered row", () => {
  const seeds = Number(process.env.KV_MEMTABLE_CASES ?? 60);
  for (let seed = 1; seed <= seeds; seed++) expect(() => run(seed)).not.toThrow();
});
