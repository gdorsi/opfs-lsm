import { compareBytes } from "../../src/bytes.js";
import { CorruptDatabaseError } from "../../src/errors.js";
import { crc32 } from "../../src/store/crc32.js";
import type { Demand, MergeCore, MergeSpec, MergeStop } from "../../src/store/engine.js";
import {
  blockLengths,
  decodeBlock,
  encodeRun,
  entryRecordSize,
  readFooter,
  SST_FOOTER_BYTES,
  type RunEnd,
  type SstCodec,
  type SstEntry,
  type SstFooter,
} from "../../src/store/sst.js";

/**
 * The merge session in TypeScript (crates/engine-abi.md, "Merge session"),
 * as an oracle for the wasm one. It asks for the same reads and merges by
 * the same rules, but holds more: it decodes each read's blocks at once and
 * gathers an output run's entries before it encodes them. Its runs are raw
 * whatever `spec.codec` says.
 */
export function openMergeTs(spec: MergeSpec): MergeCore {
  return new Session(spec);
}

type Stage =
  | { readonly kind: "running" }
  /** `need` was returned: every demand must be fed before the next pump. */
  | { readonly kind: "feeding" }
  | { readonly kind: "done" }
  /** Sticky: every later pump throws it. */
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "closed" };

class Session implements MergeCore {
  private readonly sources: Source[];
  private readonly pace = { consumed: 0 };
  private readonly dropTombstones: boolean;
  private readonly targetBytes: number;
  private readonly chunkBytes: number;
  private readonly yieldBytes: number;
  private stage: Stage = { kind: "running" };
  private dropped = 0;
  /** The open output run's entries and their encoded size. */
  private gathered: SstEntry[] = [];
  private gatheredBytes = 0;
  /** An encoded output run going out, `at` bytes of it so far. */
  private finished: { readonly body: Uint8Array; readonly end: RunEnd; at: number } | undefined;

  constructor(spec: MergeSpec) {
    if (spec.sources.some((runs) => runs.some((size) => size < SST_FOOTER_BYTES))) {
      throw new CorruptDatabaseError("sst too short");
    }
    this.chunkBytes = Math.max(1, spec.chunkBytes);
    const tailBytes = Math.max(SST_FOOTER_BYTES, spec.tailBytes);
    this.sources = spec.sources.map((runs, i) => new Source(new Reader(i, runs, this.chunkBytes, tailBytes, this.pace)));
    this.dropTombstones = spec.dropTombstones;
    this.targetBytes = spec.targetBytes;
    this.yieldBytes = Math.max(1, spec.yieldBytes);
  }

  pump(): MergeStop {
    switch (this.stage.kind) {
      case "failed":
        throw this.stage.error;
      case "closed":
        throw new Error("merge session closed");
      case "done":
        return { kind: "done", droppedSeq: this.dropped };
      case "feeding":
        if (this.sources.some((s) => s.reader.waiting())) throw new Error("merge pump: a demand was not fed");
        break;
      case "running":
        break;
    }
    this.stage = { kind: "running" };
    try {
      const stop = this.run();
      if (stop.kind === "need") this.stage = { kind: "feeding" };
      if (stop.kind === "done") this.stage = { kind: "done" };
      return stop;
    } catch (error) {
      this.stage = { kind: "failed", error };
      throw error;
    }
  }

  feed(source: number, bytes: Uint8Array): void {
    const s = this.stage.kind === "feeding" ? this.sources[source] : undefined;
    if (!s?.reader.answer(bytes)) throw new Error(`merge source ${source} has no unfed demand of ${bytes.byteLength} bytes`);
  }

  close(): void {
    this.stage = { kind: "closed" };
    this.gathered = [];
    this.finished = undefined;
  }

  private run(): MergeStop {
    this.pace.consumed = 0;
    for (;;) {
      const out = this.finished;
      if (out) {
        if (out.at < out.body.byteLength) {
          const bytes = out.body.subarray(out.at, out.at + this.chunkBytes);
          out.at += bytes.byteLength;
          return { kind: "write", bytes };
        }
        this.finished = undefined;
        return { kind: "run-end", end: out.end };
      }
      const demands: Demand[] = [];
      for (const s of this.sources) {
        const demand = s.advance();
        if (demand) demands.push(demand);
      }
      if (demands.length > 0) return { kind: "need", demands };
      if (this.pace.consumed >= this.yieldBytes) return { kind: "yield" };

      let winner: Source | undefined;
      let entry: SstEntry | undefined;
      for (const s of this.sources) {
        const e = s.settled();
        // Only a smaller key takes over, so on a tie the earlier, newer source wins.
        if (e && (!entry || compareBytes(e.key, entry.key) < 0)) {
          winner = s;
          entry = e;
        }
      }
      if (!winner || !entry) {
        if (this.gathered.length === 0) return { kind: "done", droppedSeq: this.dropped };
        this.finish();
        continue;
      }
      for (const s of this.sources) {
        const e = s.settled();
        if (s !== winner && e && compareBytes(e.key, entry.key) === 0) s.retire();
      }
      this.emit(entry);
      winner.retire();
    }
  }

  private emit(e: SstEntry): void {
    if (e.kind === "del" && this.dropTombstones) {
      this.dropped = Math.max(this.dropped, e.seq ?? 0);
      return;
    }
    this.gathered.push(e);
    this.gatheredBytes += entryRecordSize(e);
    if (this.gatheredBytes >= this.targetBytes) this.finish();
  }

  private finish(): void {
    const { body, end } = encodeRun(this.gathered);
    this.finished = { body, end, at: 0 };
    this.gathered = [];
    this.gatheredBytes = 0;
  }
}

/** Where a source stands in finding the last duplicate of its next key. */
type Head =
  | { readonly kind: "start" }
  /** `cur` is the latest entry of its key; a later one may follow. */
  | { readonly kind: "scanning"; readonly cur: SstEntry }
  /** `cur` is the last entry of its key and `look`, read after it, has the next key. */
  | { readonly kind: "ready"; readonly cur: SstEntry; readonly look: SstEntry }
  /** `cur` is the last entry of the source's last key. */
  | { readonly kind: "last"; readonly cur: SstEntry }
  | { readonly kind: "exhausted" };

/** One input stream, newest wins within it: the last duplicate of a key, across blocks, reads and runs. */
class Source {
  private head: Head = { kind: "start" };

  constructor(readonly reader: Reader) {}

  /** The entry that stands for the source's next key, once no later duplicate can follow it. */
  settled(): SstEntry | undefined {
    return this.head.kind === "ready" || this.head.kind === "last" ? this.head.cur : undefined;
  }

  /** Read on until `settled` has an entry or the source is exhausted, or return the read that must come first. */
  advance(): Demand | undefined {
    for (;;) {
      const head = this.head;
      if (head.kind !== "start" && head.kind !== "scanning") return undefined;
      const got = this.reader.next();
      if (got === undefined) {
        this.head = head.kind === "start" ? { kind: "exhausted" } : { kind: "last", cur: head.cur };
        return undefined;
      }
      if (!("kind" in got)) return got;
      if (head.kind === "start") {
        this.head = { kind: "scanning", cur: got };
        continue;
      }
      const order = compareBytes(got.key, head.cur.key);
      if (order < 0) throw new CorruptDatabaseError("sst keys out of order");
      this.head = order === 0 ? { kind: "scanning", cur: got } : { kind: "ready", cur: head.cur, look: got };
    }
  }

  /** The settled entry was merged or shadowed: the next key, already read, comes up. */
  retire(): void {
    this.head = this.head.kind === "ready" ? { kind: "scanning", cur: this.head.look } : { kind: "exhausted" };
  }
}

/** What a reader learned of its current run from the run's footer and index. */
type Layout = {
  readonly codec: SstCodec;
  readonly dataLen: number;
  readonly entryCount: number;
  /** The framed length of each data block, in file order. */
  readonly blocks: readonly number[];
  /** What the run's CRC covers after the data: the bloom, the index and the footer's fields. */
  readonly meta: Uint8Array;
  readonly storedCrc: number;
};

/** Reading a run's data blocks, a window at a time. */
type Blocks = {
  readonly kind: "blocks";
  readonly layout: Layout;
  /** Blocks asked for and blocks decoded, from the first. */
  requested: number;
  arrived: number;
  /** Where block `requested` starts. */
  offset: number;
  /** CRC and length of the data fed so far. */
  crc: number;
  fed: number;
  /** Entries decoded so far. */
  seen: number;
};

/** What a reader is reading of its current run. */
type Read =
  /** The run's tail: its footer, and its bloom and index when they fit. */
  | { readonly kind: "tail" }
  /** The bloom or index starts before the tail: the bytes in front of it are asked for. */
  | { readonly kind: "meta-rest"; readonly tail: Uint8Array; readonly footer: SstFooter }
  | Blocks
  /** Every run of the source was read and checked. */
  | { readonly kind: "done" };

/** The reader's one outstanding read. */
type Ask =
  | { readonly kind: "idle" }
  | { readonly kind: "asked"; readonly demand: Demand }
  | { readonly kind: "fed"; readonly bytes: Uint8Array };

/** Reads a source's runs one after the other. */
class Reader {
  private run = 0;
  private read: Read;
  private ask: Ask = { kind: "idle" };
  /** The decoded entries of the last read of blocks, taken from `pos` on. */
  private window: readonly SstEntry[] = [];
  private pos = 0;

  constructor(
    private readonly source: number,
    private readonly runs: readonly number[],
    private readonly chunkBytes: number,
    private readonly tailBytes: number,
    private readonly pace: { consumed: number },
  ) {
    this.read = runs.length > 0 ? { kind: "tail" } : { kind: "done" };
  }

  /** True while this reader's demand is listed and not fed. */
  waiting(): boolean {
    return this.ask.kind === "asked";
  }

  /** Take the bytes of this reader's demand. False when it has none of that length. */
  answer(bytes: Uint8Array): boolean {
    if (this.ask.kind !== "asked" || this.ask.demand.length !== bytes.byteLength) return false;
    this.ask = { kind: "fed", bytes };
    return true;
  }

  /** The source's next entry, the read it waits for, or undefined after its last entry. */
  next(): SstEntry | Demand | undefined {
    for (;;) {
      if (this.pos < this.window.length) return this.window[this.pos++];
      const read = this.read;
      const ask = this.ask;
      if (read.kind === "done") return undefined;
      if (ask.kind === "asked") return ask.demand;
      if (ask.kind === "fed") {
        this.ask = { kind: "idle" };
        if (read.kind === "blocks") this.takeData(read, ask.bytes);
        else this.takeMeta(read, ask.bytes);
      } else if (read.kind === "blocks") {
        if (read.requested < read.layout.blocks.length) return this.askData(read);
        this.endRun(read);
      } else {
        // In "tail": "meta-rest" asks for its bytes as it starts.
        return this.askTail();
      }
    }
  }

  private asks(offset: number, length: number): Demand {
    const demand = { source: this.source, run: this.run, offset, length };
    this.ask = { kind: "asked", demand };
    return demand;
  }

  private askTail(): Demand {
    const size = this.runs[this.run]!;
    const length = Math.min(size, this.tailBytes);
    return this.asks(size - length, length);
  }

  private takeMeta(read: Extract<Read, { kind: "tail" | "meta-rest" }>, bytes: Uint8Array): void {
    const size = this.runs[this.run]!;
    if (read.kind === "meta-rest") {
      const meta = new Uint8Array(bytes.byteLength + read.tail.byteLength);
      meta.set(bytes);
      meta.set(read.tail, bytes.byteLength);
      this.startBlocks(read.footer, meta);
      return;
    }
    const footer = readFooter(bytes, size);
    const tailAt = size - bytes.byteLength;
    if (footer.dataLen < tailAt) {
      this.read = { kind: "meta-rest", tail: bytes, footer };
      this.asks(footer.dataLen, tailAt - footer.dataLen);
      return;
    }
    const blocks = this.startBlocks(footer, bytes.subarray(footer.dataLen - tailAt));
    if (tailAt === 0) {
      // The tail is the whole run, so its blocks are in already.
      blocks.requested = blocks.layout.blocks.length;
      blocks.offset = footer.dataLen;
      this.takeData(blocks, bytes.subarray(0, footer.dataLen));
    }
  }

  /** Index the run from `meta`, its bytes from the end of its data on. */
  private startBlocks(footer: SstFooter, meta: Uint8Array): Blocks {
    // The CRC sits after the footer's eight fields and covers every byte before it.
    const crcAt = footer.indexEnd + 32 - footer.dataLen;
    const layout: Layout = {
      codec: footer.codec,
      dataLen: footer.dataLen,
      entryCount: footer.entryCount,
      blocks: blockLengths(meta, footer),
      meta: meta.subarray(0, crcAt),
      storedCrc: new DataView(meta.buffer, meta.byteOffset, meta.byteLength).getUint32(crcAt, true),
    };
    const blocks: Blocks = { kind: "blocks", layout, requested: 0, arrived: 0, offset: 0, crc: 0, fed: 0, seen: 0 };
    this.read = blocks;
    if (layout.dataLen === 0) checkCrc(blocks);
    return blocks;
  }

  /** Whole blocks up to `chunkBytes`, and at least one. */
  private askData(read: Blocks): Demand {
    const lengths = read.layout.blocks;
    let length = 0;
    let n = read.requested;
    while (n < lengths.length && (n === read.requested || length + lengths[n]! <= this.chunkBytes)) {
      length += lengths[n]!;
      n++;
    }
    const offset = read.offset;
    read.requested = n;
    read.offset += length;
    return this.asks(offset, length);
  }

  private takeData(read: Blocks, bytes: Uint8Array): void {
    read.crc = crc32(bytes, read.crc);
    read.fed += bytes.byteLength;
    // Checked before any entry of the run's last blocks is used.
    if (read.fed === read.layout.dataLen) checkCrc(read);
    const entries: SstEntry[] = [];
    let o = 0;
    for (; read.arrived < read.requested; read.arrived++) {
      const length = read.layout.blocks[read.arrived]!;
      for (const e of decodeBlock(bytes.subarray(o, o + length), read.layout.codec)) entries.push(e);
      o += length;
    }
    read.seen += entries.length;
    this.window = entries;
    this.pos = 0;
    this.pace.consumed += bytes.byteLength;
  }

  private endRun(read: Blocks): void {
    if (read.seen !== read.layout.entryCount) throw new CorruptDatabaseError("sst entry count mismatch");
    this.run++;
    this.read = this.run < this.runs.length ? { kind: "tail" } : { kind: "done" };
  }
}

function checkCrc(read: Blocks): void {
  if (crc32(read.layout.meta, read.crc) !== read.layout.storedCrc) throw new CorruptDatabaseError("sst crc mismatch");
}
