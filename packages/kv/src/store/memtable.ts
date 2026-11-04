import { compareBytes } from "../bytes.js";
import type { CheckedOp } from "../check.js";
import { lowerBoundKeys } from "./cursor.js";

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

/**
 * One tab's in-memory view of the WAL: the records above the installed
 * SST generation's ingestedThrough, up to appliedThrough, folded to one row per key, in key order. Records
 * must be applied in seq order with no gaps, so every read sees the state
 * after one WAL prefix.
 */
export class Memtable {
  private rows: MemRow[] = [];
  private applied = 0;

  get appliedThrough(): number {
    return this.applied;
  }

  /** The rows in key order. Callers that keep them past a write copy them. */
  get sorted(): readonly MemRow[] {
    return this.rows;
  }

  get(key: Uint8Array): MemRow | undefined {
    const i = lowerBoundKeys(this.rows, key);
    const row = this.rows[i];
    return row && compareBytes(row.key, key) === 0 ? row : undefined;
  }

  /** Apply `record` if it is the next seq. Returns false on a gap. */
  apply(record: WalRecord): boolean {
    if (record.seq <= this.applied) return true;
    if (record.seq !== this.applied + 1) return false;
    for (const op of record.ops) {
      const row: MemRow =
        op.type === "put"
          ? { key: op.key, seq: record.seq, kind: "put", value: op.value }
          : { key: op.key, seq: record.seq, kind: "del" };
      const i = lowerBoundKeys(this.rows, op.key);
      const at = this.rows[i];
      if (at && compareBytes(at.key, op.key) === 0) this.rows[i] = row;
      else this.rows.splice(i, 0, row);
    }
    this.applied = record.seq;
    return true;
  }

  /**
   * The installed SST generation now holds every seq <= `through`. Drop the
   * rows it covers, and jump past seqs this table never read.
   */
  advanceTo(through: number): void {
    if (through > this.applied) {
      this.rows = [];
      this.applied = through;
      return;
    }
    if (this.rows.some((row) => row.seq <= through)) {
      this.rows = this.rows.filter((row) => row.seq > through);
    }
  }
}
