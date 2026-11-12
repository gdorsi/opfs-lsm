import { compareBytes } from "../bytes.js";
import { ROW_OVERHEAD, type RecordOp } from "../check.js";
import { lowerBoundKeys, type ScanBounds } from "./cursor.js";
import { joinMarks, markTable, NO_MARKS, type Mark, type Marks } from "./marks.js";

/** The latest op for one user key, and the WAL seq that wrote it. */
export type MemRow = {
  readonly key: Uint8Array;
  readonly seq: number;
  readonly kind: "put" | "del";
  readonly value?: Uint8Array;
};

export type WalRecord = {
  readonly seq: number;
  readonly ops: readonly RecordOp[];
};

/** The range deletes of `record`, each at the record's seq. */
export function marksOf(record: WalRecord): Mark[] {
  const out: Mark[] = [];
  for (const op of record.ops) {
    if (op.type === "deleteRange") out.push({ ...op, at: record.seq });
  }
  return out;
}

function foldMarks(marks: readonly Mark[]): Marks {
  return marks.reduce((acc, m) => joinMarks(acc, markTable(m)), NO_MARKS);
}

/** Reads over rows in key order, live or pinned. */
export interface MemRows {
  get(key: Uint8Array): MemRow | undefined;
  /** The rows inside `bounds`, in key order. */
  range(bounds?: ScanBounds): readonly MemRow[];
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
 * is below its own `through`, cover none either.
 *
 * A pin shares chunks with the live table. The live table copies a shared
 * chunk before it writes to it, so a pin costs one array of chunk
 * references.
 */
export class Memtable extends Chunks {
  /** `owned[i]` is false while a pin may still read chunk `i`. */
  private owned: boolean[] = [true];
  private applied = 0;
  private ingested = 0;
  private live = 0;
  /** The range deletes of the records held, oldest first. */
  private markLog: Mark[] = [];
  private held: Marks = NO_MARKS;

  constructor() {
    super([[]], [new Uint8Array(0)]);
  }

  get appliedThrough(): number {
    return this.applied;
  }

  /** Key, value and `ROW_OVERHEAD` bytes of every row, moved by each write instead of counted by a scan. */
  get bytes(): number {
    return this.live;
  }

  /** The join of the range deletes of the records held. Replaced, never mutated, when it changes. */
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
    if (record.seq !== this.applied + 1) return "gap";
    for (const op of record.ops) {
      switch (op.type) {
        case "put":
          this.put({ key: op.key, seq: record.seq, kind: "put", value: op.value });
          break;
        case "del":
          this.put({ key: op.key, seq: record.seq, kind: "del" });
          break;
        case "deleteRange": {
          const mark = { ...op, at: record.seq };
          this.removeCovered(mark);
          this.markLog.push(mark);
          this.held = joinMarks(this.held, markTable(mark));
          break;
        }
      }
    }
    this.applied = record.seq;
    return "applied";
  }

  /** Remove the rows `mark` covers. Their own seqs are below the mark's record, so op order does not matter. */
  private removeCovered(mark: Mark): void {
    const { start, endExclusive: end, through } = mark;
    for (let c = chunkFor(this.firsts, start); c < this.chunks.length; c++) {
      if (end && c > 0 && compareBytes(this.firsts[c]!, end) >= 0) break;
      const rows = this.chunks[c]!;
      const lo = lowerBoundKeys(rows, start);
      const hi = end ? lowerBoundKeys(rows, end) : rows.length;
      let gone = 0;
      for (let i = lo; i < hi; i++) if (rows[i]!.seq <= through) gone++;
      if (gone === 0) continue;
      const keep = rows.filter((row, i) => {
        if (i < lo || i >= hi || row.seq > through) return true;
        this.live -= rowBytes(row);
        return false;
      });
      this.chunks[c] = keep;
      this.owned[c] = true;
    }
    for (let c = this.chunks.length - 1; c > 0; c--) {
      if (this.chunks[c]!.length > 0) continue;
      this.chunks.splice(c, 1);
      this.firsts.splice(c, 1);
      this.owned.splice(c, 1);
    }
  }

  private put(row: MemRow): void {
    const c = chunkFor(this.firsts, row.key);
    if (!this.owned[c]) {
      this.chunks[c] = this.chunks[c]!.slice();
      this.owned[c] = true;
    }
    const rows = this.chunks[c]!;
    const i = lowerBoundKeys(rows, row.key);
    const at = rows[i];
    if (at && compareBytes(at.key, row.key) === 0) {
      this.live += rowBytes(row) - rowBytes(at);
      rows[i] = row;
    } else {
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
  advanceTo(through: number): boolean {
    if (through <= this.ingested) return false;
    this.ingested = through;
    const jumped = through > this.applied;
    if (this.markLog.length > 0) {
      this.markLog = this.markLog.filter((m) => m.at > through);
      this.held = foldMarks(this.markLog);
    }
    const keep = jumped ? [] : this.range().filter((row) => row.seq > through);
    this.applied = Math.max(this.applied, through);
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
    return jumped;
  }
}
