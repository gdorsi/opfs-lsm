/**
 * Compaction as a session the host drives a stop at a time, so that the
 * engine holds a window of each input instead of the whole input
 * (abi.md, "Merge session").
 *
 * The host opens a session with the sizes of the input runs and pumps it.
 * Each pump stops between two keys and asks the host for one thing: read
 * some bytes (NEED), take output bytes (WRITE), close the output run
 * (RUN_END), give the event loop a turn (YIELD), or install the result
 * (DONE). The session owns every offset and only asks for whole blocks.
 *
 * The inputs are sources, newest first. A source is one or more runs read
 * back to back as one key-ordered stream: an L0 run, or the runs of a lower
 * level that the step overlaps. For a key, the newest source wins and,
 * within a source, the last duplicate wins, across block, read and run
 * boundaries.
 *
 * What it holds, whatever the inputs' size: per source about `chunkBytes` of
 * blocks (more only for a block, or a run's bloom and index, that is larger)
 * and two entries; for the output, one open block, a bloom hash and an index
 * row per key and block of the open run, and up to `chunkBytes` plus one
 * block of bytes not yet written.
 *
 * Every step returns a status: 0 or a stop code to go on, a negative error
 * code to stop.
 */
import { Bytes, compareBytes, equalBytes } from "./buf";
import { crc32, crc32Combine, crcUpdate } from "./crc32";
import {
  BLOCK_TARGET,
  BlockWalk,
  COUNT_MISMATCH,
  CRC_MISMATCH,
  entrySize,
  FOOTER_BYTES,
  Layout,
  NO_VALUE,
  OUT_OF_ORDER,
  RunEnd,
  TRAILING_GARBAGE,
  TRUNCATED,
  Writer,
} from "./sst";

export const OUT_OF_MEMORY: i32 = -10;
export const UNFED: i32 = -15;

// Where a pump stops (abi.md, "Merge session").
export const NEED: i32 = 1;
export const WRITE: i32 = 2;
export const RUN_END: i32 = 3;
export const YIELD: i32 = 4;
export const DONE: i32 = 5;

/** Room for what `finish` appends past `chunkBytes`: the last block and the footer. A run's bloom and index can pass it and grow `out`. */
const OUT_SLACK: usize = 2 * BLOCK_TARGET;

/** Bytes of a demand record: u32 source, run, offset and length. */
const DEMAND: usize = 16;

/** Input block bytes opened since the pump began. The module holds one session. */
let consumed: usize = 0;

// The session between pumps.
const RUNNING: u8 = 0;
/** NEED was returned and some demand may still be unfed. */
const FEEDING: u8 = 1;
/** WRITE handed out `out`, which the next pump clears. */
const WRITING: u8 = 2;
const COMPLETE: u8 = 3;
/** Sticky: every later pump returns `failure`. */
const FAILED: u8 = 4;

/** An entry copied out of a block, so it outlives the block. Its buffers keep their capacity from one entry to the next. */
@final @unmanaged
class Slot {
  key: Bytes = new Bytes();
  value: Bytes = new Bytes();
  seq: u64 = 0;
  put: bool = false;

  /** Copy the record `walk` just read from the block at `block`. */
  fill(walk: BlockWalk, block: usize): i32 {
    const key = this.key;
    key.clear();
    if (!key.tryReserve(walk.prefixLen + walk.suffixLen)) return OUT_OF_MEMORY;
    key.append(block + walk.prefixAt, walk.prefixLen);
    key.append(block + walk.suffixAt, walk.suffixLen);
    this.seq = walk.seq;
    this.put = walk.valueLen != NO_VALUE;
    if (this.put) {
      const value = this.value;
      value.clear();
      if (!value.tryReserve(walk.valueLen)) return OUT_OF_MEMORY;
      value.append(block + walk.valueAt, walk.valueLen);
    }
    return 0;
  }

  free(): void {
    this.key.free();
    this.value.free();
    heap.free(changetype<usize>(this));
  }
}

// What a source is reading of its current run.
/** The run's tail: its footer and as much of the bloom and index as fit. */
const TAIL: u8 = 0;
/** The rest of the run's bloom and index. The tail already sits at the end of `chunk[..size - layout.dataLen]`. */
const META_REST: u8 = 1;
/** Data blocks, in file order. */
const BLOCKS: u8 = 2;
/** Every run of the source was read and checked. */
const READ_DONE: u8 = 3;

// The source's one outstanding read.
const IDLE: u8 = 0;
/** Listed in a NEED; its bytes go to `chunk[askAt..askAt + askLen]`. */
const ASKED: u8 = 1;
/** Fed, not yet taken in. */
const FED: u8 = 2;

// What `Reader.next` got.
const GOT_END: i32 = 0;
const GOT_ENTRY: i32 = 1;
const GOT_WAIT: i32 = 2;

/** Reads a source's runs one after the other, a window at a time. */
@final @unmanaged
class Reader {
  index: u32 = 0;
  /** The size of each run. */
  runs: Bytes = new Bytes();
  run: usize = 0;
  read: u8 = TAIL;
  ask: u8 = IDLE;
  askOffset: usize = 0;
  askLen: usize = 0;
  askAt: usize = 0;
  chunkBytes: usize = 0;
  tailBytes: usize = 0;
  layout: Layout = new Layout();

  // The current run, from its footer and index.
  dataLen: usize = 0;
  entryCount: usize = 0;
  entriesSeen: usize = 0;
  /** Length of each data block, in file order. Blocks are contiguous from offset 0, so their offsets are running sums. */
  blocks: Bytes = new Bytes();
  /** Blocks asked for, arrived in `chunk`, and opened, in that order. */
  requested: usize = 0;
  arrived: usize = 0;
  opened: usize = 0;
  /** Where block `requested` starts. */
  nextOffset: usize = 0;

  /** Arrived bytes still needed are `chunk[chunkPos..chunkLen]`: the blocks from the open one, or from the next to open, to `arrived`. */
  chunk: Bytes = new Bytes();
  chunkPos: usize = 0;
  chunkLen: usize = 0;
  /** The block being walked sits at `chunk[chunkPos..chunkPos + openLen]`. */
  isOpen: bool = false;
  openLen: usize = 0;
  walk: BlockWalk = new BlockWalk();

  // The run's CRC covers its data and then its meta, but the meta is read
  // first: the data's CRC streams in as blocks arrive and the two combine.
  crcData: u32 = ~0;
  dataFed: usize = 0;
  crcMeta: u32 = 0;
  metaCrcLen: usize = 0;
  storedCrc: u32 = 0;

  @inline size(): usize {
    return this.runs.u32(this.run);
  }

  /** Append this reader's outstanding ask to `demands` as a demand record. */
  demand(demands: Bytes): void {
    demands.pushU32(this.index);
    demands.pushU32(<u32>this.run);
    demands.pushU32(<u32>this.askOffset);
    demands.pushU32(<u32>this.askLen);
  }

  /** Read the next entry into `slot`: `GOT_ENTRY`, `GOT_END`, `GOT_WAIT` for the outstanding ask, or an error. */
  next(slot: Slot): i32 {
    let status: i32;
    while (true) {
      const read = this.read;
      if (read == READ_DONE) return GOT_END;
      if (read != BLOCKS) {
        if (this.ask == IDLE) {
          status = this.askTail();
          return status < 0 ? status : GOT_WAIT;
        }
        if (this.ask == ASKED) return GOT_WAIT;
        this.ask = IDLE;
        status = this.takeMeta(this.askAt, this.askLen);
        if (status < 0) return status;
        continue;
      }
      status = this.walkOpen(slot);
      if (status < 0) return status;
      if (status) {
        this.entriesSeen += 1;
        return GOT_ENTRY;
      }
      if (this.opened == this.blocks.count) {
        status = this.endRun();
      } else if (this.opened < this.arrived) {
        status = this.openBlock();
      } else if (this.ask == IDLE) {
        status = this.askData();
        return status < 0 ? status : GOT_WAIT;
      } else if (this.ask == ASKED) {
        return GOT_WAIT;
      } else {
        this.ask = IDLE;
        status = this.takeData(this.askAt, this.askLen);
      }
      if (status < 0) return status;
    }
  }

  /** The next record of the open block into `slot`: 1, or 0 once no block is open. */
  private walkOpen(slot: Slot): i32 {
    if (!this.isOpen) return 0;
    const block = this.chunk.ptr + this.chunkPos;
    const status = this.walk.next(block);
    if (status > 0) {
      const filled = slot.fill(this.walk, block);
      return filled < 0 ? filled : 1;
    }
    if (status < 0) return status;
    this.chunkPos += this.openLen;
    this.isOpen = false;
    return 0;
  }

  private openBlock(): i32 {
    const len = <usize>this.blocks.u32(this.opened);
    const status = this.walk.start(this.chunk.ptr + this.chunkPos, len);
    if (status < 0) return status;
    this.isOpen = true;
    this.openLen = len;
    this.opened += 1;
    consumed += len;
    return 0;
  }

  /** Ask for the run's last `tailBytes`, which hold its footer. */
  private askTail(): i32 {
    const size = this.size();
    const len = min(size, this.tailBytes);
    this.chunkPos = 0;
    this.chunkLen = 0;
    if (len > this.chunk.len && !this.chunk.tryResize(len)) return OUT_OF_MEMORY;
    this.ask = ASKED;
    this.askOffset = size - len;
    this.askLen = len;
    this.askAt = 0;
    return 0;
  }

  private takeMeta(at: usize, len: usize): i32 {
    const size = this.size();
    const layout = this.layout;
    if (this.read == META_REST) return this.parseMeta(size - layout.dataLen);
    const tailAt = size - len;
    const status = layout.read(this.chunk.ptr + at + len - FOOTER_BYTES, size);
    if (status < 0) return status;
    if (layout.dataLen < tailAt) {
      // The bloom or index starts before the tail: read the rest in front of
      // it, so the meta is one slice.
      const metaLen = size - layout.dataLen;
      if (metaLen > this.chunk.len && !this.chunk.tryResize(metaLen)) return OUT_OF_MEMORY;
      memory.copy(this.chunk.ptr + metaLen - len, this.chunk.ptr + at, len);
      this.read = META_REST;
      this.ask = ASKED;
      this.askOffset = layout.dataLen;
      this.askLen = tailAt - layout.dataLen;
      this.askAt = 0;
      return 0;
    }
    memory.copy(this.chunk.ptr, this.chunk.ptr + at, len);
    const parsed = this.parseMeta(len);
    if (parsed < 0 || tailAt != 0) return parsed;
    // The tail is the whole run: keep its blocks.
    this.chunkLen = layout.dataLen;
    const taken = this.takeDataBytes(0, layout.dataLen);
    if (taken < 0) return taken;
    this.requested = this.blocks.count;
    this.arrived = this.blocks.count;
    this.nextOffset = layout.dataLen;
    return 0;
  }

  /** Check and index the run from its meta: `chunk[..end]` ends with the run's last bytes and holds all of its bloom, index and footer. */
  private parseMeta(end: usize): i32 {
    const layout = this.layout;
    const base = this.size() - end;
    const meta = this.chunk.ptr + layout.dataLen - base;
    const crcLen = layout.crcOff - layout.dataLen;
    this.crcMeta = crc32(meta, crcLen);
    this.metaCrcLen = crcLen;
    this.storedCrc = load<u32>(meta + crcLen);
    const index = meta + layout.indexStart - layout.dataLen;
    const status = indexBlocks(index, layout.indexEnd - layout.indexStart, layout.blockCount, layout.dataLen, this.blocks);
    if (status < 0) return status;

    this.dataLen = layout.dataLen;
    this.entryCount = layout.entryCount;
    this.entriesSeen = 0;
    this.requested = 0;
    this.arrived = 0;
    this.opened = 0;
    this.nextOffset = 0;
    this.chunkPos = 0;
    this.chunkLen = 0;
    this.crcData = ~0;
    this.dataFed = 0;
    this.read = BLOCKS;
    return layout.dataLen == 0 ? this.checkCrc() : 0;
  }

  /** Ask for the next blocks: as many whole ones as fill the chunk to `chunkBytes`, and at least one. */
  private askData(): i32 {
    const chunk = this.chunk;
    if (this.chunkPos > 0) {
      memory.copy(chunk.ptr, chunk.ptr + this.chunkPos, this.chunkLen - this.chunkPos);
      this.chunkLen -= this.chunkPos;
      this.chunkPos = 0;
    }
    const room = this.chunkBytes > this.chunkLen ? this.chunkBytes - this.chunkLen : 0;
    let len: usize = 0;
    let n = this.requested;
    const count = this.blocks.count;
    while (n < count) {
      const block = <usize>this.blocks.u32(n);
      if (n > this.requested && len + block > room) break;
      len += block;
      n += 1;
    }
    if (this.chunkLen + len > chunk.len && !chunk.tryResize(this.chunkLen + len)) return OUT_OF_MEMORY;
    this.ask = ASKED;
    this.askOffset = this.nextOffset;
    this.askLen = len;
    this.askAt = this.chunkLen;
    this.requested = n;
    this.nextOffset += len;
    return 0;
  }

  /**
   * A source on the heap that holds less than half a chunk asks for more
   * while the host is reading for another source anyway: 1 when it asked.
   */
  readAhead(): i32 {
    const low = this.chunkLen - this.chunkPos < this.chunkBytes / 2;
    if (this.read == BLOCKS && this.ask == IDLE && this.requested < this.blocks.count && low) {
      const status = this.askData();
      return status < 0 ? status : 1;
    }
    return 0;
  }

  private takeData(at: usize, len: usize): i32 {
    this.chunkLen = at + len;
    this.arrived = this.requested;
    return this.takeDataBytes(at, len);
  }

  private takeDataBytes(at: usize, len: usize): i32 {
    this.crcData = crcUpdate(this.crcData, this.chunk.ptr + at, len);
    this.dataFed += len;
    return this.dataFed == this.dataLen ? this.checkCrc() : 0;
  }

  /** Every data byte has arrived, and none of the last block was used yet. */
  private checkCrc(): i32 {
    return crc32Combine(~this.crcData, this.crcMeta, this.metaCrcLen) == this.storedCrc ? 0 : CRC_MISMATCH;
  }

  private endRun(): i32 {
    if (this.entriesSeen != this.entryCount) return COUNT_MISMATCH;
    this.run += 1;
    this.read = this.run < this.runs.count ? TAIL : READ_DONE;
    return 0;
  }

  free(): void {
    this.runs.free();
    this.blocks.free();
    this.chunk.free();
    heap.free(changetype<usize>(this.layout));
    heap.free(changetype<usize>(this.walk));
    heap.free(changetype<usize>(this));
  }
}

/**
 * The length of each block, from the index rows
 *   u32 len | first key | u32 len | last key | u32 offset | u32 length
 * Blocks must tile the data region from 0, which a run the writer wrote
 * always does, so a block's offset is the sum before it.
 */
function indexBlocks(index: usize, end: usize, count: usize, dataLen: usize, blocks: Bytes): i32 {
  blocks.clear();
  // A row is at least 16 bytes, so this bounds the rows that can parse.
  if (!blocks.tryReserve(min(count, end / 16) << 2)) return OUT_OF_MEMORY;
  let o: usize = 0;
  let next: usize = 0;
  for (let i: usize = 0; i < count; i++) {
    for (let k = 0; k < 2; k++) {
      if (end - o < 4) return TRUNCATED;
      const len = <usize>load<u32>(index + o);
      o += 4;
      if (len > end - o) return TRUNCATED;
      o += len;
    }
    if (end - o < 8) return TRUNCATED;
    const offset = <usize>load<u32>(index + o);
    const length = <usize>load<u32>(index + o, 4);
    o += 8;
    if (offset != next || length > dataLen - offset) return TRUNCATED;
    next += length;
    blocks.pushU32(<u32>length);
  }
  if (o != end) return TRAILING_GARBAGE;
  return next == dataLen ? 0 : TRUNCATED;
}

// Where a source stands in finding the last duplicate of its next key.
/** Nothing read yet. */
const START: u8 = 0;
/** `cur` holds a key; reading on into `look` for later duplicates. */
const SCANNING: u8 = 1;
/** `cur` is the last duplicate of its key and `look` holds the next key. */
const READY: u8 = 2;
/** `cur` is the last duplicate of the source's last key. */
const LAST: u8 = 3;
/** Every entry was taken. */
const EXHAUSTED: u8 = 4;

// What `Source.advance` found.
/** `cur` is final for its key: the source goes on the heap. */
const ADVANCE_READY: i32 = 0;
const ADVANCE_EXHAUSTED: i32 = 1;
/** The reader's outstanding ask must be answered first. */
const ADVANCE_WAIT: i32 = 2;

/** One input stream and the two entries it has read ahead. */
@final @unmanaged
class Source {
  reader: Reader = new Reader();
  head: u8 = START;
  cur: Slot = new Slot();
  look: Slot = new Slot();

  advance(): i32 {
    const reader = this.reader;
    while (true) {
      const head = this.head;
      if (head == START) {
        const got = reader.next(this.cur);
        if (got < 0) return got;
        if (got == GOT_WAIT) return ADVANCE_WAIT;
        if (got == GOT_END) {
          this.head = EXHAUSTED;
          return ADVANCE_EXHAUSTED;
        }
        this.head = SCANNING;
      } else if (head == SCANNING) {
        const got = reader.next(this.look);
        if (got < 0) return got;
        if (got == GOT_WAIT) return ADVANCE_WAIT;
        if (got == GOT_END) {
          this.head = LAST;
          return ADVANCE_READY;
        }
        const look = this.look;
        const cur = this.cur;
        const order = compareBytes(look.key.ptr, look.key.len, cur.key.ptr, cur.key.len);
        if (order < 0) return OUT_OF_ORDER;
        if (order > 0) {
          this.head = READY;
          return ADVANCE_READY;
        }
        this.cur = look;
        this.look = cur;
      } else {
        return head == EXHAUSTED ? ADVANCE_EXHAUSTED : ADVANCE_READY;
      }
    }
  }

  free(): void {
    this.reader.free();
    this.cur.free();
    this.look.free();
    heap.free(changetype<usize>(this));
  }
}

/** A merge of newest-first sources into key-ordered output runs. */
@final @unmanaged
export class MergeSession {
  /** A `Source` pointer per source. */
  sources: Bytes = new Bytes();
  /**
   * Sources whose `cur` is final for its key: a binary min-heap by
   * `(cur.key, source)`, so the smallest key and, for a key, the newest
   * source comes first.
   */
  heap: Bytes = new Bytes();
  /** Sources taken off the heap whose next key is still being read. */
  pending: Bytes = new Bytes();
  /** The demand records of the last NEED. */
  demands: Bytes = new Bytes();
  writer: Writer = new Writer();
  out: Bytes = new Bytes();
  /** Whether the output run was finished into `ended`; what is left of it in `out` goes out first. */
  finished: bool = false;
  /** Bytes of the open output run's entries, by `entrySize`. */
  filled: usize = 0;
  /** The run RUN_END reports. */
  ended: RunEnd = new RunEnd();
  dropTombstones: bool = false;
  /** The base manifest's marks block (abi.md, "Wire formats"), trusted: the host encoded it. */
  marks: Bytes = new Bytes();
  targetBytes: usize = 0;
  chunkBytes: usize = 0;
  yieldBytes: usize = 0;
  stage: u8 = RUNNING;
  failure: i32 = 0;

  @inline source(s: u32): Source {
    return changetype<Source>(load<usize>(this.sources.ptr + (<usize>s << 2)));
  }

  /**
   * Reserve the working set of a session over the sources of the source
   * list at `list`, checked by the caller, that drops every winner a mark of
   * the `marksLen` bytes at `marks` covers. False when it cannot be
   * reserved, so a host that cannot afford it learns so before it reads
   * anything.
   */
  reserve(list: usize, marks: usize, marksLen: usize, chunkBytes: usize, tailBytes: usize): bool {
    const n = <usize>load<u32>(list);
    if (!this.sources.tryCapacity(n << 2)) return false;
    // Objects before buffers. Only a buffer can report OUT_OF_MEMORY, and a chunk reserved first could take the room the next source's objects need.
    for (let i: usize = 0; i < n; i++) this.sources.pushU32(<u32>changetype<usize>(new Source()));
    let ok = true;
    let o: usize = 4;
    for (let i: usize = 0; i < n && ok; i++) {
      const runs = <usize>load<u32>(list + o);
      o += 4;
      const source = this.source(<u32>i);
      const reader = source.reader;
      reader.index = <u32>i;
      reader.chunkBytes = max<usize>(chunkBytes, 1);
      reader.tailBytes = max(tailBytes, FOOTER_BYTES);
      reader.read = runs ? TAIL : READ_DONE;
      ok =
        reader.runs.tryCapacity(runs << 2) &&
        reader.chunk.tryResize(reader.chunkBytes) &&
        source.cur.key.tryCapacity(64) &&
        source.cur.value.tryCapacity(256) &&
        source.look.key.tryCapacity(64) &&
        source.look.value.tryCapacity(256);
      if (ok) reader.runs.append(list + o, runs << 2);
      o += runs << 2;
    }
    ok = ok && this.heap.tryCapacity(n << 2) && this.pending.tryCapacity(n << 2) && this.demands.tryCapacity(n * DEMAND);
    const slack = chunkBytes + OUT_SLACK;
    ok = ok && this.out.tryCapacity(slack < chunkBytes ? usize.MAX_VALUE : slack) && this.marks.tryCapacity(marksLen);
    if (!ok) return false;
    for (let i: u32 = 0; i < <u32>n; i++) this.pending.pushU32(i);
    this.marks.append(marks, marksLen);
    return true;
  }

  /**
   * Merge until the host has to act. After NEED, every demand must be fed
   * first; a pump before that returns `UNFED` and changes nothing. Any other
   * error is final: the inputs are corrupt or memory ran out, and no output
   * of the session may be installed.
   */
  pump(): i32 {
    const stage = this.stage;
    if (stage == FAILED) return this.failure;
    if (stage == COMPLETE) return DONE;
    if (stage == FEEDING) {
      const n = this.sources.count;
      for (let i: u32 = 0; i < <u32>n; i++) if (this.source(i).reader.ask == ASKED) return UNFED;
      this.demands.clear();
    } else if (stage == WRITING) {
      this.out.clear();
    }
    this.stage = RUNNING;
    const stop = this.run();
    if (stop == NEED) this.stage = FEEDING;
    else if (stop == WRITE) this.stage = WRITING;
    else if (stop == DONE) this.stage = COMPLETE;
    else if (stop < 0) {
      this.stage = FAILED;
      this.failure = stop;
    }
    return stop;
  }

  /** Where the `len` bytes of `source`'s demand go, to be filled before the next pump. 0 when `source` has no unfed demand of that length. */
  feed(source: u32, len: usize): usize {
    if (this.stage != FEEDING || <usize>source >= this.sources.count) return 0;
    const reader = this.source(source).reader;
    if (reader.ask != ASKED || reader.askLen != len) return 0;
    reader.ask = FED;
    return reader.chunk.ptr + reader.askAt;
  }

  private run(): i32 {
    consumed = 0;
    while (true) {
      if (this.finished) {
        if (this.out.len) return WRITE;
        this.finished = false;
        this.filled = 0;
        return RUN_END;
      }
      if (this.out.len >= this.chunkBytes) return WRITE;
      let status = this.advancePending();
      if (status < 0) return status;
      if (this.demands.len) {
        status = this.readAhead();
        return status < 0 ? status : NEED;
      }
      if (consumed >= this.yieldBytes) return YIELD;
      if (!this.heap.len) {
        if (this.writer.entries == 0) return DONE;
        this.writer.finish(this.out, this.ended);
        this.finished = true;
        continue;
      }
      status = this.nextKey();
      if (status < 0) return status;
    }
  }

  /** Bring every pending source back to the heap, or list what it must read. */
  private advancePending(): i32 {
    const pending = this.pending;
    let i: usize = 0;
    while (i < pending.count) {
      const s = pending.u32(i);
      const source = this.source(s);
      const advance = source.advance();
      if (advance < 0) return advance;
      if (advance == ADVANCE_WAIT) {
        source.reader.demand(this.demands);
        i += 1;
        continue;
      }
      pending.len -= 4;
      pending.setU32(i, pending.u32(pending.count));
      if (advance == ADVANCE_READY) this.heapPush(s);
    }
    return 0;
  }

  /** The host is about to read anyway: refill every source running low. */
  private readAhead(): i32 {
    const n = this.sources.count;
    for (let i: u32 = 0; i < <u32>n; i++) {
      const reader = this.source(i).reader;
      const status = reader.readAhead();
      if (status < 0) return status;
      if (status) reader.demand(this.demands);
    }
    return 0;
  }

  /**
   * Settle the smallest key: the newest source's entry wins, the same key in
   * older sources is shadowed, and each of those sources moves on. A winner
   * a mark covers is dropped in any merge: every older version of its key
   * has a smaller seq, so the same mark covers it too.
   */
  private nextKey(): i32 {
    const w = this.heapPop();
    const winner = this.source(w).cur;
    const key = winner.key.ptr;
    const keyLen = winner.key.len;
    while (this.heap.len) {
      const t = this.heap.u32(0);
      const other = this.source(t).cur.key;
      if (!equalBytes(other.ptr, other.len, key, keyLen)) break;
      this.heapPop();
      this.retire(t);
    }
    if (this.covered(key, keyLen, winner.seq)) {
      this.retire(w);
      return 0;
    }
    if (winner.put || !this.dropTombstones) {
      const valueLen = winner.put ? winner.value.len : NO_VALUE;
      const size = (this.finished ? <usize>0 : this.filled) + entrySize(keyLen, valueLen);
      const status = this.writer.push(key, keyLen, winner.value.ptr, valueLen, winner.seq, this.out);
      if (status < 0) return status;
      if (size >= this.targetBytes) {
        this.writer.finish(this.out, this.ended);
        this.finished = true;
      } else {
        this.finished = false;
        this.filled = size;
      }
    }
    this.retire(w);
    return 0;
  }

  /**
   * Whether the highest `through` among the marks whose range holds `key`
   * is at least `seq`. Marks are read in place:
   *   u32 count · per mark: u32 start_len · start · u8 has_end
   *   · (u32 end_len · end) · u64 through · u64 at
   * The host encoded the block, so a malformed one is a host bug and traps
   * where a read would leave it, as abi.md says.
   */
  private covered(key: usize, keyLen: usize, seq: u64): bool {
    const marks = this.marks.ptr;
    const len = this.marks.len;
    let through: u64 = 0;
    let o: usize = 4;
    while (o < len) {
      if (len - o < 4) unreachable();
      const start = o + 4;
      const end = start + load<u32>(marks + o);
      if (end < start || end >= len) unreachable();
      const hasEnd = load<u8>(marks + end) == 1;
      let next = end + 1;
      let stop: usize = 0;
      let stopLen: usize = 0;
      if (hasEnd) {
        if (len - next < 4) unreachable();
        stopLen = load<u32>(marks + next);
        stop = marks + next + 4;
        next += 4 + stopLen;
        if (next < end + 5 || next > len) unreachable();
      }
      if (
        compareBytes(marks + start, end - start, key, keyLen) <= 0 &&
        (!hasEnd || compareBytes(key, keyLen, stop, stopLen) < 0)
      ) {
        if (len - next < 8) unreachable();
        through = max(through, load<u64>(marks + next));
      }
      o = next + 16;
    }
    return through > 0 && seq <= through;
  }

  /** `s`'s `cur` was taken: its next key, already read, becomes `cur`. */
  private retire(s: u32): void {
    const source = this.source(s);
    if (source.head == READY) {
      const cur = source.cur;
      source.cur = source.look;
      source.look = cur;
      source.head = SCANNING;
      this.pending.pushU32(s);
    } else {
      source.head = EXHAUSTED;
    }
  }

  @inline private before(a: u32, b: u32): bool {
    const x = this.source(a).cur.key;
    const y = this.source(b).cur.key;
    const order = compareBytes(x.ptr, x.len, y.ptr, y.len);
    return order < 0 || (order == 0 && a < b);
  }

  private heapPush(s: u32): void {
    const h = this.heap;
    h.pushU32(s);
    let i = h.count - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(h.u32(i), h.u32(parent))) break;
      const v = h.u32(i);
      h.setU32(i, h.u32(parent));
      h.setU32(parent, v);
      i = parent;
    }
  }

  private heapPop(): u32 {
    const h = this.heap;
    const top = h.u32(0);
    h.len -= 4;
    const n = h.count;
    if (n) h.setU32(0, h.u32(n));
    let i: usize = 0;
    while (true) {
      let m = i;
      const l = (i << 1) + 1;
      const r = l + 1;
      if (l < n && this.before(h.u32(l), h.u32(m))) m = l;
      if (r < n && this.before(h.u32(r), h.u32(m))) m = r;
      if (m == i) return top;
      const v = h.u32(i);
      h.setU32(i, h.u32(m));
      h.setU32(m, v);
      i = m;
    }
  }

  free(): void {
    const n = this.sources.count;
    for (let i: u32 = 0; i < <u32>n; i++) this.source(i).free();
    this.sources.free();
    this.heap.free();
    this.pending.free();
    this.demands.free();
    this.writer.free();
    this.out.free();
    this.ended.free();
    this.marks.free();
    heap.free(changetype<usize>(this));
  }
}
