import { compareBytes } from "../bytes.js";
import { ROW_OVERHEAD, type CheckedOp } from "../check.js";
import { nextSeq, SEQ_ZERO, type Seq } from "../seq.js";
import { lowerBoundKeys, type ScanBounds } from "./cursor.js";
import { NO_MARKS, type Marks } from "./marks.js";

/** The latest op for one user key, and the WAL seq that wrote it. */
export type MemRow = {
  readonly key: Uint8Array;
  readonly seq: Seq;
  readonly kind: "put" | "del";
  readonly value?: Uint8Array;
};

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

/** Rows per chunk after a split. A chunk splits when it passes twice this. */
const CHUNK_ROWS = 64;

function rowBytes(row: MemRow): number {
  return ROW_OVERHEAD + row.key.byteLength + (row.value?.byteLength ?? 0);
}

type Keyed = { readonly key: Uint8Array };

/**
 * Sorted rows beside a fingerprint of each key, so a search reads one array
 * of numbers and opens a row only when two fingerprints tie. Every key
 * starts with the same `skip` bytes, and `fps[i]` is the fingerprint of
 * `rows[i].key` after them. A chunk a reader can reach holds a row when its
 * `skip` is above 0.
 */
type Chunk<R extends Keyed = MemRow> = { readonly rows: R[]; readonly fps: number[]; readonly skip: number };

/** Bytes in a fingerprint: six fit a double exactly. */
const FP_BYTES = 6;

/**
 * `FP_BYTES` bytes of `key` from `skip`, big-endian, zero where the key has
 * ended. Of two keys alike up to `skip`, the lower never has the higher
 * fingerprint.
 */
function fingerprint(key: Uint8Array, skip: number): number {
  if (skip + FP_BYTES <= key.length) {
    const high = (key[skip]! << 16) | (key[skip + 1]! << 8) | key[skip + 2]!;
    return high * 0x1000000 + ((key[skip + 3]! << 16) | (key[skip + 4]! << 8) | key[skip + 5]!);
  }
  let fp = 0;
  for (let i = skip; i < skip + FP_BYTES; i++) fp = fp * 256 + (i < key.length ? key[i]! : 0);
  return fp;
}

/** How many of their first `max` bytes `a` and `b` share. */
function shared(a: Uint8Array, b: Uint8Array, max: number): number {
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** The longest prefix the keys of sorted `rows` share: the one its first and last key share. */
function prefixOf(rows: readonly Keyed[]): number {
  if (rows.length === 0) return 0;
  const first = rows[0]!.key;
  const last = rows[rows.length - 1]!.key;
  return shared(first, last, Math.min(first.length, last.length));
}

function chunkOf<R extends Keyed>(rows: R[], skip = prefixOf(rows)): Chunk<R> {
  const fps: number[] = [];
  for (const row of rows) fps.push(fingerprint(row.key, skip));
  return { rows, fps, skip };
}

function copyOf<R extends Keyed>(chunk: Chunk<R>): Chunk<R> {
  return { rows: chunk.rows.slice(), fps: chunk.fps.slice(), skip: chunk.skip };
}

/**
 * `chunk` ready to take `key`: with a skip `key` starts with too. A key from
 * outside its prefix shortens the skip, and the first key of an empty chunk
 * sets it.
 */
function fitted<R extends Keyed>(chunk: Chunk<R>, key: Uint8Array): Chunk<R> {
  const head = chunk.rows[0];
  const skip = head ? shared(key, head.key, chunk.skip) : key.length;
  return skip === chunk.skip ? chunk : chunkOf(chunk.rows, skip);
}

/**
 * `chunk` with a longer skip once its keys share two more bytes, as the
 * halves of a split may. One more byte is not taken: a chunk whose keys sit
 * at a byte boundary would be fingerprinted again each time a key crossed it.
 */
function tightened(chunk: Chunk): Chunk {
  const skip = prefixOf(chunk.rows);
  return skip >= chunk.skip + 2 ? chunkOf(chunk.rows, skip) : chunk;
}

function insert<R extends Keyed>(chunk: Chunk<R>, i: number, row: R): void {
  chunk.rows.splice(i, 0, row);
  chunk.fps.splice(i, 0, fingerprint(row.key, chunk.skip));
}

/** `compareBytes` for two keys alike in their first `from` bytes, or in every byte either has before `from`. */
function compareFrom(a: Uint8Array, b: Uint8Array, from: number): number {
  const n = Math.min(a.length, b.length);
  for (let i = from; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * The index of `key` in `chunk`, or `~i` when it is absent and belongs at
 * `i`. `key` must start with the chunk's skip.
 */
function search(chunk: Chunk<Keyed>, key: Uint8Array): number {
  const { rows, fps, skip } = chunk;
  const fp = fingerprint(key, skip);
  // Two keys with one fingerprint differ only after it, or in length.
  const from = skip + FP_BYTES;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = fps[mid]!;
    if (at < fp || (at === fp && compareFrom(rows[mid]!.key, key, from) < 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo < rows.length && fps[lo] === fp && compareFrom(rows[lo]!.key, key, from) === 0 ? lo : ~lo;
}

/** `search` for any key: one that does not start with the chunk's skip sorts before or after every row. */
function find(chunk: Chunk<Keyed>, key: Uint8Array): number {
  const { rows, skip } = chunk;
  if (skip > 0) {
    const head = rows[0]!.key;
    const n = shared(key, head, skip);
    if (n < skip) return n < key.length && key[n]! > head[n]! ? ~rows.length : ~0;
  }
  return search(chunk, key);
}

/**
 * The chunk that holds `key` or would. `top` holds the first key of every
 * chunk but chunk 0, which also takes every key before them.
 */
function chunkFor(top: Chunk<Keyed>, key: Uint8Array): number {
  const i = find(top, key);
  return i >= 0 ? i + 1 : ~i;
}

/** Sorted rows split into chunks, so an insert moves at most one chunk. */
class Chunks implements MemRows {
  constructor(
    protected chunks: Chunk[],
    protected top: Chunk<Keyed>,
  ) {}

  get(key: Uint8Array): MemRow | undefined {
    const chunk = this.chunks[chunkFor(this.top, key)]!;
    const i = find(chunk, key);
    return i >= 0 ? chunk.rows[i] : undefined;
  }

  range(bounds?: ScanBounds): readonly MemRow[] {
    const out: MemRow[] = [];
    let c = bounds?.start ? chunkFor(this.top, bounds.start) : 0;
    let i = bounds?.start ? lowerBoundKeys(this.chunks[c]!.rows, bounds.start) : 0;
    const end = bounds?.endExclusive;
    for (; c < this.chunks.length; c++, i = 0) {
      const rows = this.chunks[c]!.rows;
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
 * references and a copy of the chunks' first keys.
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
    super([chunkOf([])], chunkOf([]));
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
    return new Chunks(this.chunks.slice(), copyOf(this.top));
  }

  /** Apply `record` if it is the next seq. "applied" only when this call moved `appliedThrough`. */
  apply(record: WalRecord): "applied" | "already" | "gap" {
    if (record.seq <= this.applied) return "already";
    if (record.seq !== nextSeq(this.applied)) return "gap";
    for (const op of record.ops) {
      switch (op.type) {
        case "put":
          this.put({ key: op.key, seq: record.seq, kind: "put", value: op.value });
          break;
        case "del":
          this.put({ key: op.key, seq: record.seq, kind: "del" });
          break;
        case "deleteRange": {
          const { start, endExclusive: end, through } = op;
          // The rows' own seqs are below this record, so op order does not matter.
          this.rebuild(
            this.range().filter(
              (row) => row.seq > through || compareBytes(row.key, start) < 0 || (end !== undefined && compareBytes(row.key, end) >= 0),
            ),
          );
          if (through > 0) this.held = [...this.held, { ...op, at: record.seq }];
          break;
        }
      }
    }
    this.applied = record.seq;
    return "applied";
  }

  private put(row: MemRow): void {
    const c = chunkFor(this.top, row.key);
    let chunk = this.chunks[c]!;
    if (!this.owned[c]) {
      chunk = copyOf(chunk);
      this.owned[c] = true;
    }
    chunk = this.chunks[c] = fitted(chunk, row.key);
    const { rows } = chunk;
    const i = search(chunk, row.key);
    if (i >= 0) {
      this.live += rowBytes(row) - rowBytes(rows[i]!);
      rows[i] = row;
      return;
    }
    this.live += rowBytes(row);
    insert(chunk, ~i, row);
    if (rows.length > 2 * CHUNK_ROWS) {
      const tail = tightened({ rows: rows.splice(CHUNK_ROWS), fps: chunk.fps.splice(CHUNK_ROWS), skip: chunk.skip });
      this.chunks[c] = tightened(chunk);
      this.chunks.splice(c + 1, 0, tail);
      this.owned.splice(c + 1, 0, true);
      const first = { key: tail.rows[0]!.key };
      this.top = fitted(this.top, first.key);
      insert(this.top, c, first);
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
    this.rebuild(jumped ? [] : this.range().filter((row) => row.seq > through));
    return jumped;
  }

  /** Replaces every chunk with `keep`, in fresh arrays, so a pin keeps what it read. */
  private rebuild(keep: readonly MemRow[]): void {
    this.chunks = [];
    const firsts: Keyed[] = [];
    this.live = 0;
    for (const row of keep) this.live += rowBytes(row);
    for (let i = 0; i < keep.length; i += CHUNK_ROWS) {
      const rows = keep.slice(i, i + CHUNK_ROWS);
      this.chunks.push(chunkOf(rows));
      if (i > 0) firsts.push({ key: rows[0]!.key });
    }
    if (this.chunks.length === 0) this.chunks.push(chunkOf([]));
    this.top = chunkOf(firsts);
    this.owned = this.chunks.map(() => true);
  }
}
