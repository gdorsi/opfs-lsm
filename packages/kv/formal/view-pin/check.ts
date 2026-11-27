/**
 * View pin: a pin reads the memtable as it was when it was taken, whatever
 * the live table does after: a put that overwrites a row, one that inserts
 * a row and splits a chunk, a delete, a range delete across that split, a
 * range delete that empties a chunk between two others, and a generation
 * install that drops rows. So does a range of the live table, which a scan
 * reads in place. Runs the real `Memtable`, from a table one row short of a
 * split and from a table of three chunks, through every sequence of those
 * writes up to MAX_STEPS long, takes a pin, a live range or a bounded live
 * range before each write, or one pin before the first, and checks every pin's `get`, `range` and marks, and every range's
 * rows and `get`, against what the table read when it was taken. After each
 * sequence the live table must read its records folded under their own range
 * deletes (LiveExact).
 *
 * Sync: db.ts hands the view `mem.pin()` and the read point it took then.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareBytes } from "../../src/bytes.js";
import type { CheckedKey, CheckedValue, ResolvedOp, ResolvedSeq } from "../../src/check.js";
import { asSeq, type Seq } from "../../src/seq.js";
import { Memtable, type MemRange, type MemRow, type MemRows } from "../../src/store/memtable.js";
import type { Mark, Marks } from "../../src/store/marks.js";

const MAX_STEPS = 5;
/** Rows a chunk holds before the next insert splits it. */
const FULL_CHUNK = 1024;
/** Rows of each chunk an install rebuilds. */
const CHUNK_ROWS = 512;

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys: CheckedKey[] = [];
// One array per key, so a row the table holds and the oracle's row share their key.
const keyOf = (i: number) => (keys[i] ??= enc.encode(`k${String(i).padStart(5, "0")}`) as CheckedKey);
const indexOf = (key: Uint8Array) => Number(dec.decode(key).slice(1));

type Write = "overwrite" | "insertLow" | "insertHigh" | "delete" | "deleteRange" | "deleteChunk" | "install";

/** The keys a get probes: every key a write touches, and the rows at the split point, the chunk bounds and the ends. */
const PROBES = [0, 1, 2, 3, 5, 150, 2 * 511, 2 * 512, 2 * (FULL_CHUNK - 1), 2 * FULL_CHUNK, 2 * FULL_CHUNK + 1, 2 * FULL_CHUNK + 3, 2 * (3 * CHUNK_ROWS - 1)].map(keyOf);

/** The record a write appends at `seq`, or undefined for an install. */
function recordOf(write: Write, seq: Seq, n: number): ResolvedOp[] | undefined {
  const value = enc.encode(`v${seq}`) as CheckedValue;
  switch (write) {
    case "overwrite":
      return [{ type: "put", key: keyOf(0), value }];
    case "insertLow":
      return [{ type: "put", key: keyOf(2 * n + 1), value }];
    case "insertHigh":
      return [{ type: "put", key: keyOf(2 * FULL_CHUNK + 2 * n + 1), value }];
    case "delete":
      return [{ type: "del", key: keyOf(2) }];
    case "deleteRange":
      return [{ type: "deleteRange", start: keyOf(900), endExclusive: keyOf(1100), through: (seq - 1) as ResolvedSeq }];
    case "deleteChunk":
      return [{ type: "deleteRange", start: keyOf(2 * CHUNK_ROWS), endExclusive: keyOf(4 * CHUNK_ROWS), through: (seq - 1) as ResolvedSeq }];
    case "install":
      return undefined;
  }
}

/** What the live table must read: its records past the install, folded to one row per key under their own range deletes. */
type Live = { readonly rows: Map<number, MemRow>; marks: Mark[] };

function fold(live: Live, seq: Seq, ops: readonly ResolvedOp[]): void {
  for (const op of ops) {
    if (op.type === "put") live.rows.set(indexOf(op.key), { key: op.key, seq, kind: "put", value: op.value });
    else if (op.type === "del") live.rows.set(indexOf(op.key), { key: op.key, seq, kind: "del" });
    else if (op.through > 0) {
      const lo = indexOf(op.start);
      const hi = op.endExclusive ? indexOf(op.endExclusive) : Number.POSITIVE_INFINITY;
      for (const [i, row] of live.rows) if (i >= lo && i < hi && row.seq <= op.through) live.rows.delete(i);
      live.marks.push({ start: op.start, ...(op.endExclusive && { endExclusive: op.endExclusive }), through: op.through, at: seq });
    }
  }
}

/**
 * The tables the writes start from. `one` is a chunk one row short of a split. `three` is three
 * chunks an install rebuilt, so `deleteChunk` empties the middle one and `insertHigh` writes the
 * one after it.
 */
const LAYOUTS: Record<"one" | "three", { readonly writes: readonly Write[]; build(mem: Memtable, live: Live): void }> = {
  one: {
    writes: ["overwrite", "insertLow", "insertHigh", "delete", "deleteRange", "install"],
    build(mem, live) {
      const fill: ResolvedOp[] = [];
      for (let k = 0; k < FULL_CHUNK; k++) fill.push({ type: "put", key: keyOf(2 * k), value: enc.encode("v1") as CheckedValue });
      mem.apply({ seq: asSeq(1), ops: fill });
      fold(live, asSeq(1), fill);
    },
  },
  three: {
    writes: ["deleteRange", "deleteChunk", "insertHigh", "install"],
    build(mem, live) {
      const fill: ResolvedOp[] = [];
      for (let k = 0; k < 3 * CHUNK_ROWS; k++) fill.push({ type: "put", key: keyOf(2 * k), value: enc.encode("v2") as CheckedValue });
      mem.apply({ seq: asSeq(1), ops: [{ type: "put", key: keyOf(99999), value: enc.encode("v1") as CheckedValue }] });
      mem.apply({ seq: asSeq(2), ops: fill });
      mem.advanceTo(asSeq(1));
      fold(live, asSeq(2), fill);
    },
  },
};
type Layout = keyof typeof LAYOUTS;

/** What the live table reads differs from its folded records, in words, or undefined. */
function inexact(mem: Memtable, live: Live): string | undefined {
  const want = [...live.rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  const got = rowsOf(mem.range());
  if (got.length !== want.length || got.some((r, i) => r.key !== want[i]!.key || r.seq !== want[i]!.seq || r.kind !== want[i]!.kind)) {
    return `the live table reads other rows than its records fold to (${got.length} rows, ${want.length} folded)`;
  }
  for (const key of PROBES) {
    if (mem.get(key)?.seq !== live.rows.get(indexOf(key))?.seq) return `the live table's get ${dec.decode(key)} reads another row than its records fold to`;
  }
  const marks = mem.marks;
  const same = (m: Mark, w: Mark) => m.start === w.start && m.endExclusive === w.endExclusive && m.through === w.through && m.at === w.at;
  if (marks.length !== live.marks.length || marks.some((m, i) => !same(m, live.marks[i]!))) return "the live table holds other marks than its records";
  return undefined;
}

type Bounds = { readonly start: Uint8Array; readonly endExclusive: Uint8Array };

/**
 * The bounds of a live range a scan takes. `low` runs from the first chunk across the split point,
 * a key a write inserts, and the range delete. `high` starts inside the chunk a split makes, so the
 * first chunk, which writes reach, lies outside it, and holds every key `insertHigh` writes.
 */
const BOUNDS: Record<"low" | "high", Bounds> = {
  low: { start: keyOf(5), endExclusive: keyOf(2 * FULL_CHUNK + 2) },
  high: { start: keyOf(2 * 600 + 1), endExclusive: keyOf(2 * FULL_CHUNK + 2 * MAX_STEPS + 2) },
};

/** How a reader holds the table: a pin, or one range of the live table, which a scan reads in place. */
type By = "pin" | "once" | "range" | keyof typeof BOUNDS;
const BY: By[] = ["pin", "once", "range", "low", "high"];

/** A pin or a live range, and what the table read when it was taken. */
type Taken = {
  readonly pin?: { readonly rows: MemRows; readonly marks: Marks; readonly wantMarks: Marks };
  readonly range?: { readonly range: MemRange; readonly bounds?: Bounds };
  readonly want: readonly MemRow[];
};

function take(mem: Memtable, by: By): Taken {
  // Read from the chunks themselves: a range would share them and hide a range that does not.
  const want = (inside(mem).chunks as MemRow[][]).flat();
  if (by === "range") return { range: { range: mem.range() }, want };
  if (by !== "pin" && by !== "once") return { range: { range: mem.range(BOUNDS[by]), bounds: BOUNDS[by] }, want };
  return { pin: { rows: mem.pin(), marks: mem.marks, wantMarks: [...mem.marks] }, want };
}

function rowsOf(range: MemRange, reverse = false): MemRow[] {
  const out: MemRow[] = [];
  const cursor = range.cursor(reverse);
  for (let row = cursor.peek(); row; cursor.next(), row = cursor.peek()) out.push(row as MemRow);
  return reverse ? out.reverse() : out;
}

const inBounds = (b: Bounds | undefined) => (key: Uint8Array) => !b || (compareBytes(key, b.start) >= 0 && compareBytes(key, b.endExclusive) < 0);
const sameKey = (key: Uint8Array) => (r: MemRow) => r.key.length === key.length && r.key.every((b, i) => b === key[i]);

/** What `taken` reads differs from what it read when taken, in words, or undefined. */
function drift({ pin, range, want }: Taken): string | undefined {
  // A range answers `get` for the keys inside the bounds it was taken with, as a scan asks.
  const reads: [string, MemRange, MemRows, readonly MemRow[], readonly Uint8Array[]][] = [];
  if (range) {
    const keep = inBounds(range.bounds);
    reads.push([range.bounds ? "a bounded live range" : "a live range", range.range, range.range, want.filter((r) => keep(r.key)), PROBES.filter(keep)]);
  }
  if (pin) reads.push(["a pin", pin.rows.range(), pin.rows, want, PROBES]);
  for (const [what, range, table, rows, probes] of reads) {
    for (const reverse of [false, true]) {
      const got = rowsOf(range, reverse);
      if (got.length !== rows.length || got.some((r, i) => r !== rows[i])) {
        return `${what} reads other rows${reverse ? " in reverse" : ""} than when taken (${got.length} rows, ${rows.length} then)`;
      }
    }
    for (const key of probes) {
      if (table.get(key) !== rows.find(sameKey(key))) return `${what}'s get ${new TextDecoder().decode(key)} reads another row than when taken`;
    }
  }
  if (pin && (pin.marks.length !== pin.wantMarks.length || pin.marks.some((m, i) => m !== pin.wantMarks[i]))) {
    return "the marks a pin took changed";
  }
  return undefined;
}

type Table = new () => Memtable;

/**
 * The first sequence of writes from `layout` after which a pin or a live range, as `by` takes them,
 * reads another state, or the live table reads other than its folded records, or undefined.
 */
function explore(Table: Table, by: By, layout: Layout): { found: string; sequences: number } | { found?: undefined; sequences: number } {
  const { writes: choices, build } = LAYOUTS[layout];
  const sequences: Write[][] = [[]];
  for (let i = 0; i < sequences.length; i++) {
    const writes = sequences[i]!;
    if (writes.length < MAX_STEPS) for (const w of choices) sequences.push([...writes, w]);
    const mem = new Table();
    const live: Live = { rows: new Map(), marks: [] };
    build(mem, live);
    const pins: Taken[] = [];
    for (const [n, w] of writes.entries()) {
      // `once` holds one pin across every write, so no later pin or range marks a chunk shared again.
      if (by !== "once" || n === 0) pins.push(take(mem, by));
      const seq = asSeq(mem.appliedThrough + 1);
      const ops = recordOf(w, seq, n);
      if (ops) {
        mem.apply({ seq, ops });
        fold(live, seq, ops);
      } else {
        mem.advanceTo(mem.appliedThrough);
        live.rows.clear();
        live.marks = [];
      }
    }
    const where = `${layout} chunk${layout === "one" ? "" : "s"}, [${writes.join(", ")}]`;
    for (const [at, pin] of pins.entries()) {
      let found: string | undefined;
      try {
        found = drift(pin);
      } catch (err) {
        found = `a read threw ${String(err)}`;
      }
      if (found) return { found: `${found}: taken before write ${at + 1} of ${where}`, sequences: i + 1 };
    }
    let found: string | undefined;
    try {
      found = inexact(mem, live);
    } catch (err) {
      found = `a read threw ${String(err)}`;
    }
    if (found) return { found: `${found}: after ${where}`, sequences: i + 1 };
  }
  return { sequences: sequences.length };
}

/** db.ts hands the view the pin and the read point of marks it took in the same expression. */
function viewPinsInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const db = fs.readFileSync(path.resolve(here, "../../src/db.ts"), "utf8");
  return /new ViewSnapshotImpl\([^)]*this\.mem\.pin\(\),\s*layers\.levels,\s*this\.point\(\)/s.test(db);
}

if (!viewPinsInSource()) {
  console.error("FAIL ViewPin — db.ts no longer hands the view `this.mem.pin()` and the read point it took then");
  process.exit(1);
}

/** The fields a broken pin reaches into, as a wrong pin would. */
type Inside = { chunks: unknown; firsts: unknown; owned: boolean[]; put(row: MemRow): void };
const inside = (o: object) => o as unknown as Inside;

const broken: [string, By, Layout, Table][] = [
  [
    "a range delete appended to the live marks array in place",
    "pin",
    "one",
    class extends Memtable {
      override apply(record: Parameters<Memtable["apply"]>[0]) {
        const self = this as unknown as { held: unknown[] };
        const before = self.held;
        const out = super.apply(record);
        if (self.held !== before && before.length > 0) {
          before.push(...self.held.slice(before.length));
          self.held = before;
        }
        return out;
      }
    },
  ],
  [
    "a pin that shares the live chunk array",
    "pin",
    "one",
    class extends Memtable {
      override pin(): MemRows {
        const pin = super.pin();
        inside(pin).chunks = inside(this).chunks;
        return pin;
      }
    },
  ],
  [
    "a pin that shares the live first keys",
    "pin",
    "one",
    class extends Memtable {
      override pin(): MemRows {
        const pin = super.pin();
        inside(pin).firsts = inside(this).firsts;
        return pin;
      }
    },
  ],
  [
    "a pin that leaves its chunks owned by the live table",
    "pin",
    "one",
    class extends Memtable {
      override pin(): MemRows {
        const pin = super.pin();
        inside(this).owned.fill(true);
        return pin;
      }
    },
  ],
  [
    "a range that leaves its chunks owned by the live table",
    "range",
    "one",
    class extends Memtable {
      protected override share(): void {}
    },
  ],
  [
    "a bounded range that leaves its chunks owned by the live table",
    "high",
    "one",
    class extends Memtable {
      protected override share(c: number, d: number): void {
        if (c === 0 && d === (inside(this).chunks as unknown[]).length - 1) super.share(c, d);
      }
    },
  ],
  [
    "a range delete that removes rows from a chunk in place",
    "range",
    "one",
    class extends Memtable {
      override apply(record: Parameters<Memtable["apply"]>[0]): ReturnType<Memtable["apply"]> {
        const op = record.ops[0];
        if (op?.type !== "deleteRange" || record.seq <= this.appliedThrough) return super.apply(record);
        // Writes the shared chunks themselves, then applies the record to what is left.
        for (const rows of inside(this).chunks as MemRow[][]) {
          for (let i = rows.length - 1; i >= 0; i--) {
            const k = rows[i]!.key;
            if (compareBytes(k, op.start) >= 0 && (!op.endExclusive || compareBytes(k, op.endExclusive) < 0) && rows[i]!.seq <= op.through) rows.splice(i, 1);
          }
        }
        return super.apply(record);
      }
    },
  ],
  [
    "a range delete that drops a chunk and keeps its owned flag",
    "once",
    "three",
    class extends Memtable {
      override apply(record: Parameters<Memtable["apply"]>[0]): ReturnType<Memtable["apply"]> {
        const self = inside(this);
        const firsts = (self.firsts as Uint8Array[]).slice();
        const owned = self.owned.slice();
        const out = super.apply(record);
        const now = self.firsts as Uint8Array[];
        // The flags as they were, at the index of each chunk the delete dropped: the owned array never splices.
        if (now.length < firsts.length) {
          let j = 0;
          self.owned = firsts.map((first, i) => (now[j] === first ? self.owned[j++]! : owned[i]!));
        }
        return out;
      }
    },
  ],
  [
    "a range delete that spares the rows at its through",
    "pin",
    "one",
    class extends Memtable {
      override apply(record: Parameters<Memtable["apply"]>[0]): ReturnType<Memtable["apply"]> {
        const op = record.ops[0];
        if (op?.type !== "deleteRange" || record.seq <= this.appliedThrough) return super.apply(record);
        const inRange = (k: Uint8Array) => compareBytes(k, op.start) >= 0 && (!op.endExclusive || compareBytes(k, op.endExclusive) < 0);
        const spared = (inside(this).chunks as MemRow[][]).flat().filter((row) => row.seq === op.through && inRange(row.key));
        const out = super.apply(record);
        for (const row of spared) inside(this).put(row);
        return out;
      }
    },
  ],
];
for (const [name, by, layout, Table] of broken) {
  const { found } = explore(Table, by, layout);
  if (!found) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
  if (process.env.FORMAL_VIEW_SHOW) console.log(`    ${found}`);
}

let sequences = 0;
for (const layout of ["one", "three"] as const) {
  for (const by of BY) {
    const { found, sequences: n } = explore(Memtable, by, layout);
    if (found) {
      console.error(`FAIL ViewPin — ${found}`);
      console.error("\nHarm: view() or range() is not a snapshot, or the memtable is not the fold of its records — a read sees a write it should not, or misses one.");
      process.exit(1);
    }
    if (by === "once") sequences += n;
  }
}
console.log(`PASS ViewPin, LiveExact — ${sequences} write sequences on the real Memtable from two layouts, a pin or a live range taken before each write reads what it read when taken, and the live table reads its records folded`);
