import { ClosedError, CommitError } from "../errors.js";
import type { LogId, PredEdge, RecordN } from "../host/queues.js";
import { encodeHeader, encodeRecords, encodeSeal, FRAME_HEAD_BYTES, frameSeed, HEADER_BYTES } from "./segment.js";

/** The SyncAccessHandle calls a writer makes on one segment file. */
export interface SegmentFile {
  /** Writes `bytes` at offset `at` and returns how many it wrote. */
  write(bytes: Uint8Array, at: number): number;
  flush(): void;
  close(): void;
}

/** Creates the empty file `segmentPath(log, firstN)` and opens it. */
export interface SegmentStore {
  create(log: LogId, firstN: RecordN): Promise<SegmentFile>;
}

export type QueueWriterOptions = {
  /** A write that would take the open segment past this size goes to a new segment, unless the segment has no record yet. */
  readonly segmentBytes: number;
  /** For a log started after a failed write: the log given up and its last acked record, written in the first header. */
  readonly pred?: PredEdge;
  /** A fresh u32 per segment. */
  readonly nonce?: () => number;
};

type Segment = { readonly file: SegmentFile; readonly firstN: RecordN; readonly seed: number; size: number };

type State = { readonly kind: "live"; readonly seg: Segment } | { readonly kind: "failed" } | { readonly kind: "closed" };

const randomNonce = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/**
 * Appends one log. Calls run one at a time in call order. A record is acked
 * when the write() that carried it returned its full length. A segment is
 * sealed, flushed and closed before its successor is created, and the
 * successor's header is flushed before any of its frames. After any call
 * throws or writes short, the writer refuses every call and opens no
 * segment: the caller starts a new log with pred `{ log, lastN: lastAcked }`.
 */
export class QueueWriter {
  private state: State;
  private acked: RecordN = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: SegmentStore,
    private readonly log: LogId,
    private readonly segmentBytes: number,
    private readonly nonce: () => number,
    seg: Segment,
  ) {
    this.state = { kind: "live", seg };
  }

  /** Creates the log's first segment and flushes its header, with `pred`, before resolving. */
  static async open(store: SegmentStore, log: LogId, options: QueueWriterOptions): Promise<QueueWriter> {
    const nonce = options.nonce ?? randomNonce;
    const seg = await startSegment(store, log, 1, nonce(), options.pred);
    return new QueueWriter(store, log, options.segmentBytes, nonce, seg);
  }

  /** The last record whose write returned its full length: after a failure, the next log's pred `lastN`. */
  get lastAcked(): RecordN {
    return this.acked;
  }

  /** Writes `bodies` as the next records in one write() and resolves with the last one's n. */
  append(bodies: readonly Uint8Array[]): Promise<RecordN> {
    return this.run(async (seg) => {
      let size = 0;
      for (const body of bodies) size += FRAME_HEAD_BYTES + body.byteLength;
      if (seg.size + size > this.segmentBytes) seg = await this.seal(seg);
      writeAll(seg.file, encodeRecords(bodies, this.acked + 1, seg.seed), seg.size);
      seg.size += size;
      this.acked += bodies.length;
      return this.acked;
    });
  }

  /** Makes every acked record durable and resolves with that n. */
  flush(): Promise<RecordN> {
    return this.run((seg) => {
      seg.file.flush();
      return this.acked;
    });
  }

  /** Seals the open segment and opens its successor, so readers see a finished segment. Does nothing to a segment with no record. */
  rotate(): Promise<void> {
    return this.run(async (seg) => void (await this.seal(seg)));
  }

  /** Flushes and closes the open segment without sealing it, so the dead log reads to its end. Does nothing after a failure. */
  close(): Promise<void> {
    return this.enqueue(() => {
      if (this.state.kind !== "live") return;
      const { file } = this.state.seg;
      try {
        file.flush();
        file.close();
      } catch (err) {
        this.fail();
        throw err;
      }
      this.state = { kind: "closed" };
    });
  }

  private async seal(seg: Segment): Promise<Segment> {
    const n = this.acked + 1;
    if (n === seg.firstN) return seg;
    writeAll(seg.file, encodeSeal(n, seg.seed), seg.size);
    seg.file.flush();
    seg.file.close();
    const next = await startSegment(this.store, this.log, n, this.nonce());
    this.state = { kind: "live", seg: next };
    return next;
  }

  private run<T>(op: (seg: Segment) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const s = this.state;
      if (s.kind === "failed") throw new CommitError(`log ${this.log} failed after record ${this.acked}`);
      if (s.kind === "closed") throw new ClosedError(`log ${this.log} is closed`);
      try {
        return await op(s.seg);
      } catch (err) {
        this.fail();
        throw err;
      }
    });
  }

  private fail(): void {
    if (this.state.kind === "live") closeQuietly(this.state.seg.file);
    this.state = { kind: "failed" };
  }

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const done = this.tail.then(op);
    this.tail = done.catch(() => undefined);
    return done;
  }
}

async function startSegment(store: SegmentStore, log: LogId, firstN: RecordN, nonce: number, pred?: PredEdge): Promise<Segment> {
  const file = await store.create(log, firstN);
  try {
    writeAll(file, encodeHeader(pred ? { nonce, firstN, pred } : { nonce, firstN }), 0);
    file.flush();
  } catch (err) {
    closeQuietly(file);
    throw err;
  }
  return { file, firstN, seed: frameSeed(nonce), size: HEADER_BYTES };
}

function writeAll(file: SegmentFile, bytes: Uint8Array, at: number): void {
  const wrote = file.write(bytes, at);
  if (wrote !== bytes.byteLength) throw new CommitError(`short write: ${wrote} of ${bytes.byteLength} bytes`);
}

function closeQuietly(file: SegmentFile): void {
  try {
    file.close();
  } catch {}
}
