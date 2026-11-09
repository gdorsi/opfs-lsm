import { compareBytes } from "../bytes.js";
import type { CheckedOp } from "../check.js";
import { lowerBoundKeys, type ScanBounds } from "./cursor.js";

/** The latest op for one user key, and the WAL seq that wrote it. */
export type MemRow = {
  readonly key: Uint8Array;
  readonly seq: number;
  readonly kind: "put" | "del";
  readonly value?: Uint8Array;
};

export type WalRecord = {
  readonly seq: number;
  readonly ops: readonly CheckedOp[];
};

/** Reads over rows in key order, live or pinned. */
export interface MemRows {
  get(key: Uint8Array): MemRow | undefined;
  /** The rows inside `bounds`, in key order. */
  range(bounds?: ScanBounds): readonly MemRow[];
}

/** Rows per chunk after a split. A chunk splits when it passes twice this. */
const CHUNK_ROWS = 512;

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
 * One tab's in-memory view of the logs: the stable records above the
 * installed SST generation's `through`, up to appliedThrough, folded to one
 * row per key, in key order. Records must be applied in seq order with no
 * gaps, so every read sees the state after one prefix of the order.
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

  constructor() {
    super([[]], [new Uint8Array(0)]);
  }

  get appliedThrough(): number {
    return this.applied;
  }

  /** The rows as they are now. Later writes don't change what it reads. */
  pin(): MemRows {
    this.owned.fill(false);
    return new Chunks(this.chunks.slice(), this.firsts.slice());
  }

  /** Apply `record` if it is the next seq. Returns false on a gap. */
  apply(record: WalRecord): boolean {
    if (record.seq <= this.applied) return true;
    if (record.seq !== this.applied + 1) return false;
    for (const op of record.ops) {
      this.put(
        op.type === "put"
          ? { key: op.key, seq: record.seq, kind: "put", value: op.value }
          : { key: op.key, seq: record.seq, kind: "del" },
      );
    }
    this.applied = record.seq;
    return true;
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
      rows[i] = row;
    } else {
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
   * rows it covers, and jump past seqs this table never read.
   */
  advanceTo(through: number): void {
    if (through <= this.ingested) return;
    this.ingested = through;
    const keep =
      through > this.applied ? [] : this.range().filter((row) => row.seq > through);
    this.applied = Math.max(this.applied, through);
    this.chunks = [];
    this.firsts = [];
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

/** `top` read over `bottom`: a key in `top` hides the same key in `bottom`. */
export function layered(top: MemRows, bottom: MemRows): MemRows {
  return {
    get: (key) => top.get(key) ?? bottom.get(key),
    range(bounds) {
      const a = top.range(bounds);
      if (a.length === 0) return bottom.range(bounds);
      const b = bottom.range(bounds);
      const out: MemRow[] = [];
      let i = 0;
      let j = 0;
      while (i < a.length || j < b.length) {
        const c = i >= a.length ? 1 : j >= b.length ? -1 : compareBytes(a[i]!.key, b[j]!.key);
        if (c <= 0) {
          out.push(a[i++]!);
          if (c === 0) j++;
        } else {
          out.push(b[j++]!);
        }
      }
      return out;
    },
  };
}
