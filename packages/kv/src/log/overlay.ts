import { opsBytes, type CheckedOp } from "../check.js";
import type { LogId, QueueCursor, RecordN } from "../host/queues.js";
import type { ScanBounds } from "../store/cursor.js";
import { Memtable, type MemRow, type MemRows } from "../store/memtable.js";

/** One acked batch of this page, held until the installed manifest covers it. */
export type OwnRecord = {
  readonly n: RecordN;
  readonly ops: readonly CheckedOp[];
  /** Key and value bytes of `ops`. */
  readonly bytes: number;
};

/** `records` are `floor + 1`, `floor + 2`, ... with no gaps. */
type LogState = { floor: RecordN; records: OwnRecord[] };

/**
 * This page's acked records that the installed manifest does not cover yet,
 * read on top of the installed runs. A page has several logs at once when a
 * failed write made it start a new one before the old one was ingested.
 *
 * The records are the truth. `logs` maps each log, oldest first, to the
 * records it still holds, and `floor` is how far the installed manifest
 * covers it (`Infinity` once the log is final or retired). `index` only
 * answers reads: the records folded to one row per key, in log order and
 * then by n. `add` applies one record at the end of it. A drop shortens
 * record lists and then replays what is left into a fresh index, so no row
 * of a dropped record can outlive it, and a key whose newest record was
 * dropped reads the newest record that survives, or is not here.
 *
 * Replaying costs the surviving records, which are the writes made since the
 * host read the log. `Memtable.advanceTo` cannot do this drop: it cuts a
 * prefix of one sequence, and a damaged log's kept tail outlives the dropped
 * prefix of the log that replaced it.
 *
 * `MemRow.seq` is the position in this order, not a WAL seq.
 */
export class OwnQueue implements MemRows {
  private readonly logs = new Map<LogId, LogState>();
  private newest: LogState | undefined;
  private index = new Memtable();
  private held = 0;

  /** Key and value bytes of every held record. */
  get bytes(): number {
    return this.held;
  }

  /**
   * Record an acked batch as record `n` of `log`. A record the installed
   * manifest already covers is ignored. Otherwise `n` must follow the log's
   * last record, and only the newest log takes records, because the order
   * puts an older log's records before every record of the log that replaced
   * it.
   */
  add(log: LogId, n: RecordN, ops: readonly CheckedOp[]): void {
    let state = this.logs.get(log);
    if (state && n <= state.floor) return;
    if (state && state !== this.newest) throw new RangeError(`log ${log} was replaced by a newer log`);
    const want = state ? state.floor + state.records.length + 1 : 1;
    if (n !== want) throw new RangeError(`log ${log} takes record ${want} next, got ${n}`);
    if (!state) {
      state = { floor: 0, records: [] };
      this.logs.set(log, state);
      this.newest = state;
    }
    const bytes = opsBytes(ops);
    state.records.push({ n, ops, bytes });
    this.held += bytes;
    this.index.apply({ seq: this.index.appliedThrough + 1, ops });
  }

  /** The newest held write of `key`, a tombstone included. Undefined: read the runs. */
  get(key: Uint8Array): MemRow | undefined {
    return this.index.get(key);
  }

  /**
   * The rows inside `bounds` in key order. A reverse scan turns them around
   * in `arrayCursor`, as it does for the memtable.
   */
  range(bounds?: ScanBounds): readonly MemRow[] {
    return this.index.range(bounds);
  }

  /**
   * Take the cursors of a newly installed manifest, in the same task that
   * swaps in its runs. Drops each log's records up to its cursor, and all of
   * a final log's. A damaged log keeps the records past its cursor for
   * `above`. A cursor never moves a log's floor back, and a cursor for a log
   * this page never wrote is ignored.
   */
  install(cursors: readonly QueueCursor[]): void {
    let dropped = false;
    for (const c of cursors) {
      const state = this.logs.get(c.log);
      if (state) dropped = this.cover(state, c.state === "final" ? Infinity : c.n) || dropped;
    }
    if (dropped) this.rebuild();
  }

  /**
   * Drop everything of `log`, once its records past a damaged cursor are
   * re-appended to a newer log. Call it before the host can ingest those
   * copies, or the kept tail shadows later writes the runs already hold.
   */
  retire(log: LogId): void {
    const state = this.logs.get(log);
    if (state && this.cover(state, Infinity)) this.rebuild();
  }

  /** The held records of `log` after record `n`, in order. */
  above(log: LogId, n: RecordN): readonly OwnRecord[] {
    return this.logs.get(log)?.records.filter((r) => r.n > n) ?? [];
  }

  /** The rows as they are now. Later `add`, `install` and `retire` calls don't change what it reads. */
  pin(): MemRows {
    return this.index.pin();
  }

  private cover(state: LogState, upTo: RecordN): boolean {
    state.floor = Math.max(state.floor, upTo);
    let k = 0;
    while (k < state.records.length && state.records[k]!.n <= state.floor) this.held -= state.records[k++]!.bytes;
    state.records.splice(0, k);
    return k > 0;
  }

  private rebuild(): void {
    const index = new Memtable();
    for (const { records } of this.logs.values()) {
      for (const r of records) index.apply({ seq: index.appliedThrough + 1, ops: r.ops });
    }
    this.index = index;
  }
}
