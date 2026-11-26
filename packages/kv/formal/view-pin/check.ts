/**
 * View pin: a pin reads the memtable as it was when it was taken, whatever
 * the live table does after: a put that overwrites a row, one that inserts
 * a row and splits a chunk, a delete, a range delete across that split, and
 * a generation install that drops rows. So does a range of the live table,
 * which a scan reads in place. Runs the real `Memtable`, from a table one
 * row short of a split, through every sequence of those writes up to
 * MAX_STEPS long, takes a pin and two live ranges before each write, and
 * checks every pin's `get`, `range` and marks, and every range's rows and
 * `get`, against what the table read when it was taken.
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
import type { Marks } from "../../src/store/marks.js";

const MAX_STEPS = 5;
/** Rows a chunk holds before the next insert splits it. */
const FULL_CHUNK = 1024;

const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`) as CheckedKey;

type Write = "overwrite" | "insertLow" | "insertHigh" | "delete" | "deleteRange" | "install";
const WRITES: Write[] = ["overwrite", "insertLow", "insertHigh", "delete", "deleteRange", "install"];

/** The keys a get probes: every key a write touches, and the rows at the split point and the ends. */
const PROBES = [0, 1, 2, 3, 5, 150, 2 * 511, 2 * 512, 2 * (FULL_CHUNK - 1), 2 * FULL_CHUNK + 1, 2 * FULL_CHUNK + 3].map(keyOf);

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
    case "install":
      return undefined;
  }
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
type By = "pin" | "range" | keyof typeof BOUNDS;
const BY: By[] = ["pin", "range", "low", "high"];

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
  if (by !== "pin") return { range: { range: mem.range(BOUNDS[by]), bounds: BOUNDS[by] }, want };
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

/** The first sequence of writes after which a pin or a live range, as `by` takes them, reads another state, or undefined. */
function explore(Table: Table, by: By): string | undefined {
  const sequences: Write[][] = [[]];
  for (let i = 0; i < sequences.length; i++) {
    const writes = sequences[i]!;
    if (writes.length < MAX_STEPS) for (const w of WRITES) sequences.push([...writes, w]);
    const mem = new Table();
    const fill: ResolvedOp[] = [];
    for (let k = 0; k < FULL_CHUNK; k++) fill.push({ type: "put", key: keyOf(2 * k), value: enc.encode("v1") as CheckedValue });
    mem.apply({ seq: asSeq(1), ops: fill });
    const pins: Taken[] = [];
    for (const [n, w] of writes.entries()) {
      pins.push(take(mem, by));
      const seq = asSeq(mem.appliedThrough + 1);
      const ops = recordOf(w, seq, n);
      if (ops) mem.apply({ seq, ops });
      else mem.advanceTo(mem.appliedThrough);
    }
    for (const [at, pin] of pins.entries()) {
      let found: string | undefined;
      try {
        found = drift(pin);
      } catch (err) {
        found = `a read threw ${String(err)}`;
      }
      if (found) return `${found}: taken before write ${at + 1} of [${writes.join(", ")}]`;
    }
  }
  return undefined;
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
type Inside = { chunks: unknown; firsts: unknown; owned: boolean[] };
const inside = (o: object) => o as unknown as Inside;

const broken: [string, By, Table][] = [
  [
    "a range delete appended to the live marks array in place",
    "pin",
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
    class extends Memtable {
      protected override share(): void {}
    },
  ],
  [
    "a bounded range that leaves its chunks owned by the live table",
    "high",
    class extends Memtable {
      protected override share(c: number, d: number): void {
        if (c === 0 && d === (inside(this).chunks as unknown[]).length - 1) super.share(c, d);
      }
    },
  ],
  [
    "a range delete that removes rows from a chunk in place",
    "range",
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
];
for (const [name, by, Table] of broken) {
  if (!explore(Table, by)) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

let found: string | undefined;
for (const by of BY) found ??= explore(Memtable, by);
if (found) {
  console.error(`FAIL ViewPin — ${found}`);
  console.error("\nHarm: view() or range() is not a snapshot — later writes change results mid-read.");
  process.exit(1);
}
const sequences = (WRITES.length ** (MAX_STEPS + 1) - 1) / (WRITES.length - 1);
console.log(`PASS ViewPin — ${sequences} write sequences on the real Memtable, a pin or a live range taken before each write reads what it read when taken`);
