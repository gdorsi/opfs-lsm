/**
 * View pin: a pin reads the memtable as it was when it was taken, whatever
 * the live table does after: a put that overwrites a row, one that inserts
 * a row and splits a chunk, a delete, a range delete, and a generation
 * install that drops rows. Runs the real `Memtable`, from a table one row
 * short of a split, through every sequence of those writes up to MAX_STEPS
 * long, takes a pin before each write, and checks every pin's `get`,
 * `range` and marks against what the table read when it was taken.
 *
 * Sync: db.ts hands the view `mem.pin()` and the read point it took then.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckedKey, CheckedOp, CheckedValue } from "../../src/check.js";
import { asSeq, type Seq } from "../../src/seq.js";
import { Memtable, type MemRow, type MemRows } from "../../src/store/memtable.js";
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
function recordOf(write: Write, seq: Seq, n: number): CheckedOp[] | undefined {
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
      return [{ type: "deleteRange", start: keyOf(100), endExclusive: keyOf(200), through: asSeq(seq - 1) }];
    case "install":
      return undefined;
  }
}

/** A pin and what the table read when it was taken. */
type Taken = { readonly rows: MemRows; readonly marks: Marks; readonly want: readonly MemRow[]; readonly wantMarks: Marks };

function take(mem: Memtable): Taken {
  return { rows: mem.pin(), marks: mem.marks, want: mem.range(), wantMarks: [...mem.marks] };
}

/** What `pin` reads differs from what it read when taken, in words, or undefined. */
function drift(pin: Taken): string | undefined {
  const rows = pin.rows.range();
  if (rows.length !== pin.want.length || rows.some((r, i) => r !== pin.want[i])) {
    return `range reads other rows than when pinned (${rows.length} rows, ${pin.want.length} then)`;
  }
  for (const key of PROBES) {
    const want = pin.want.find((r) => r.key.length === key.length && r.key.every((b, i) => b === key[i]));
    if (pin.rows.get(key) !== want) return `get ${new TextDecoder().decode(key)} reads another row than when pinned`;
  }
  if (pin.marks.length !== pin.wantMarks.length || pin.marks.some((m, i) => m !== pin.wantMarks[i])) {
    return "the marks it took changed";
  }
  return undefined;
}

type Table = new () => Memtable;

/** The first sequence of writes after which a pin reads another state, or undefined. */
function explore(Table: Table): string | undefined {
  const sequences: Write[][] = [[]];
  for (let i = 0; i < sequences.length; i++) {
    const writes = sequences[i]!;
    if (writes.length < MAX_STEPS) for (const w of WRITES) sequences.push([...writes, w]);
    const mem = new Table();
    const fill: CheckedOp[] = [];
    for (let k = 0; k < FULL_CHUNK; k++) fill.push({ type: "put", key: keyOf(2 * k), value: enc.encode("v1") as CheckedValue });
    mem.apply({ seq: asSeq(1), ops: fill });
    const pins: Taken[] = [];
    for (const [n, w] of writes.entries()) {
      pins.push(take(mem));
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
      if (found) return `${found}: pinned before write ${at + 1} of [${writes.join(", ")}]`;
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

const broken: [string, Table][] = [
  [
    "a pin that shares the live chunk array",
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
    class extends Memtable {
      override pin(): MemRows {
        const pin = super.pin();
        inside(this).owned.fill(true);
        return pin;
      }
    },
  ],
];
for (const [name, Table] of broken) {
  if (!explore(Table)) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

const found = explore(Memtable);
if (found) {
  console.error(`FAIL ViewPin — ${found}`);
  console.error("\nHarm: view() is not a snapshot — later writes change results mid-callback.");
  process.exit(1);
}
const sequences = (WRITES.length ** (MAX_STEPS + 1) - 1) / (WRITES.length - 1);
console.log(`PASS ViewPin — ${sequences} write sequences on the real Memtable, a pin before each write reads what it read when taken`);
