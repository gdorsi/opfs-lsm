import { compareBytes } from "../bytes.js";
import { ROW_OVERHEAD, type CheckedOp } from "../check.js";
import { nextSeq, SEQ_ZERO, type Seq } from "../seq.js";
import { lowerBoundKeys, type ScanBounds } from "./cursor.js";
import { NO_MARKS, type Marks } from "./marks.js";
import type { Sum, Was } from "./sst.js";

/**
 * One op folded into a row after its first: its seq, and whether the key
 * was live before it, which the op before it says.
 */
type Link = { readonly seq: Seq; readonly was: Was };

/**
 * The latest op for one user key, and the WAL seq that wrote it.
 *
 * A row stands for every op of its key the table holds, so it says what
 * held before the oldest of them: `was`. When the generation moves past
 * that op, the row has to say what held before the oldest one left, so it
 * keeps the later ops as `later`. Most rows fold one op and have neither
 * `since` nor `later`.
 */
export type MemRow = {
  readonly key: Uint8Array;
  readonly seq: Seq;
  readonly kind: "put" | "del";
  readonly value?: Uint8Array;
  /** Whether the key was live before the oldest op folded. Undefined: that op did not say. */
  readonly was?: Was | undefined;
  /** The seq of the oldest op folded, when it is not `seq`. */
  readonly since?: Seq;
  /** The ops folded after the oldest, oldest first. The last one is at `seq`. */
  readonly later?: readonly Link[];
};

/** The first op of `key`: nothing of it was held. */
function firstRow(key: Uint8Array, seq: Seq, value: Uint8Array | undefined, was: Was | undefined): MemRow {
  return value ? { key, seq, kind: "put", value, was } : { key, seq, kind: "del", was };
}

/** `held`, then one more op of its key. What held before that op is what `held` left. */
function foldRow(held: MemRow, seq: Seq, value: Uint8Array | undefined): MemRow {
  const link: Link = { seq, was: held.kind === "put" ? "present" : "absent" };
  const chain = { was: held.was, since: held.since ?? held.seq, later: held.later ? [...held.later, link] : [link] };
  return value ? { key: held.key, seq, kind: "put", value, ...chain } : { key: held.key, seq, kind: "del", ...chain };
}

/**
 * `row` without the ops at or below `through`, which a run now holds or a
 * range delete covers. Undefined when no op is left.
 */
function rowAfter(row: MemRow, through: Seq): MemRow | undefined {
  if (row.seq <= through) return undefined;
  if (row.since === undefined || row.since > through) return row;
  const later = row.later!;
  let i = 0;
  while (later[i]!.seq <= through) i++;
  const { key, seq, kind, value } = row;
  const oldest = later[i]!;
  const rest = oldest.seq === seq ? {} : { since: oldest.seq, later: later.slice(i + 1) };
  return value ? { key, seq, kind, value, was: oldest.was, ...rest } : { key, seq, kind, was: oldest.was, ...rest };
}

export type WalRecord = {
  readonly seq: Seq;
  readonly ops: readonly CheckedOp[];
};

/** Reads over rows in key order, live or pinned. */
export interface MemRows {
  get(key: Uint8Array): MemRow | undefined;
  /** The rows inside `bounds`, in key order. */
  range(bounds?: ScanBounds): readonly MemRow[];
}

/** What `rows` say they do to the number of live keys (`Tally`). */
export function tallyRows(rows: readonly MemRow[], sum: Sum): void {
  for (const row of rows) sum.count(row.kind === "put", row.was);
}

/** Rows per chunk after a split. A chunk splits when it passes twice this. */
const CHUNK_ROWS = 512;

function rowBytes(row: MemRow): number {
  return ROW_OVERHEAD + row.key.byteLength + (row.value?.byteLength ?? 0);
}

/**
 * The chunk that holds `key` or would. `firsts[i]` is the first key of
 * chunk `i`, and chunk 0 also takes every key before `firsts[1]`.
 */
function chunkFor(firsts: readonly Uint8Array[], key: Uint8Array): number {
  let lo = 1;
  let hi = firsts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareBytes(firsts[mid]!, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Sorted rows split into chunks, so an insert moves at most one chunk. */
class Chunks implements MemRows {
  constructor(
    protected chunks: MemRow[][],
    protected firsts: Uint8Array[],
  ) {}

  get(key: Uint8Array): MemRow | undefined {
    const rows = this.chunks[chunkFor(this.firsts, key)]!;
    const row = rows[lowerBoundKeys(rows, key)];
    return row && compareBytes(row.key, key) === 0 ? row : undefined;
  }

  range(bounds?: ScanBounds): readonly MemRow[] {
    const out: MemRow[] = [];
    let c = bounds?.start ? chunkFor(this.firsts, bounds.start) : 0;
    let i = bounds?.start ? lowerBoundKeys(this.chunks[c]!, bounds.start) : 0;
    const end = bounds?.endExclusive;
    for (; c < this.chunks.length; c++, i = 0) {
      const rows = this.chunks[c]!;
      const last = rows[rows.length - 1];
      const stop =
        end && last && compareBytes(last.key, end) >= 0
          ? lowerBoundKeys(rows, end)
          : rows.length;
      for (; i < stop; i++) out.push(rows[i]!);
      if (stop < rows.length) return out;
    }
    return out;
  }
}

/**
 * One tab's in-memory view of the WAL: the records above the installed
 * SST generation's ingestedThrough, up to appliedThrough, folded to one row
 * per key, in key order, under their own range deletes. Records must be
 * applied in seq order with no gaps, so every read sees the state after one
 * WAL prefix.
 *
 * A row a range delete covers is removed when that record applies, so no
 * row held is covered by `marks`, and a manifest's marks, whose `through`
 * is below its own `through`, cover none either. A row the range delete
 * spares, because an op of its key is past `through`, keeps only those ops.
 * If the oldest of them saw the key present, what it saw may be a version
 * the range delete covers, so the row no longer says what held before it.
 *
 * A pin shares chunks with the live table. The live table copies a shared
 * chunk before it writes to it, so a pin costs one array of chunk
 * references.
 */
export class Memtable extends Chunks {
  /** `owned[i]` is false while a pin may still read chunk `i`. */
  private owned: boolean[] = [true];
  private applied = SEQ_ZERO;
  private ingested = SEQ_ZERO;
  private live = 0;
  /** The range deletes of the records held, oldest first. Replaced, never mutated. */
  private held: Marks = NO_MARKS;

  constructor() {
    super([[]], [new Uint8Array(0)]);
  }

  get appliedThrough(): Seq {
    return this.applied;
  }

  /** The seq `advanceTo` last moved to: the installed generation holds every seq up to it. */
  get ingestedThrough(): Seq {
    return this.ingested;
  }

  /** Key, value and `ROW_OVERHEAD` bytes of every row, moved by each write instead of counted by a scan. */
  get bytes(): number {
    return this.live;
  }

  /** The range deletes of the records held. */
  get marks(): Marks {
    return this.held;
  }

  /** The rows as they are now. Later writes don't change what it reads. */
  pin(): MemRows {
    this.owned.fill(false);
    return new Chunks(this.chunks.slice(), this.firsts.slice());
  }

  /** Apply `record` if it is the next seq. "applied" only when this call moved `appliedThrough`. */
  apply(record: WalRecord): "applied" | "already" | "gap" {
    if (record.seq <= this.applied) return "already";
    if (record.seq !== nextSeq(this.applied)) return "gap";
    for (const op of record.ops) {
      switch (op.type) {
        case "put":
          this.put(op.key, record.seq, op.value, op.was);
          break;
        case "del":
          this.put(op.key, record.seq, undefined, op.was);
          break;
        case "deleteRange": {
          const { start, endExclusive: end, through } = op;
          // The rows' own seqs are below this record, so op order does not matter.
          const kept: MemRow[] = [];
          for (const row of this.range()) {
            if (compareBytes(row.key, start) < 0 || (end !== undefined && compareBytes(row.key, end) >= 0)) {
              kept.push(row);
              continue;
            }
            const spared = rowAfter(row, through);
            if (spared) kept.push(spared.was === "present" ? { ...spared, was: undefined } : spared);
          }
          this.rebuild(kept);
          if (through > 0) this.held = [...this.held, { ...op, at: record.seq }];
          break;
        }
      }
    }
    this.applied = record.seq;
    return "applied";
  }

  /** One put, or a delete when `value` is undefined. `was` is what the op says held before it. */
  private put(key: Uint8Array, seq: Seq, value: Uint8Array | undefined, was: Was | undefined): void {
    const c = chunkFor(this.firsts, key);
    if (!this.owned[c]) {
      this.chunks[c] = this.chunks[c]!.slice();
      this.owned[c] = true;
    }
    const rows = this.chunks[c]!;
    const i = lowerBoundKeys(rows, key);
    const at = rows[i];
    if (at && compareBytes(at.key, key) === 0) {
      const row = foldRow(at, seq, value);
      this.live += rowBytes(row) - rowBytes(at);
      rows[i] = row;
    } else {
      const row = firstRow(key, seq, value, was);
      this.live += rowBytes(row);
      rows.splice(i, 0, row);
    }
    if (rows.length > 2 * CHUNK_ROWS) {
      const tail = rows.splice(CHUNK_ROWS);
      this.chunks.splice(c + 1, 0, tail);
      this.firsts.splice(c + 1, 0, tail[0]!.key);
      this.owned.splice(c + 1, 0, true);
    }
  }

  /**
   * The installed SST generation now holds every seq <= `through`. Drop the
   * rows and range deletes it covers, and jump past seqs this table never
   * read. True when it jumped.
   */
  advanceTo(through: Seq): boolean {
    if (through <= this.ingested) return false;
    this.ingested = through;
    const jumped = through > this.applied;
    if (this.held[0] && this.held[0].at <= through) this.held = this.held.filter((m) => m.at > through);
    this.applied = through > this.applied ? through : this.applied;
    const kept: MemRow[] = [];
    if (!jumped) {
      for (const row of this.range()) {
        const left = rowAfter(row, through);
        if (left) kept.push(left);
      }
    }
    this.rebuild(kept);
    return jumped;
  }

  /** Replaces every chunk with `keep`, in fresh arrays, so a pin keeps what it read. */
  private rebuild(keep: readonly MemRow[]): void {
    this.chunks = [];
    this.firsts = [];
    this.live = 0;
    for (const row of keep) this.live += rowBytes(row);
    for (let i = 0; i < keep.length; i += CHUNK_ROWS) {
      const rows = keep.slice(i, i + CHUNK_ROWS);
      this.chunks.push(rows);
      this.firsts.push(rows[0]!.key);
    }
    if (this.chunks.length === 0) this.chunks.push([]);
    this.firsts[0] = new Uint8Array(0);
    this.owned = this.chunks.map(() => true);
  }
}
