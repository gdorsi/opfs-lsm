import {
  KIND_RECORD,
  KIND_SEAL,
  encodeFrame,
  segmentPath,
  type Stamp,
  type TabId,
} from "./frame.js";

/** The synchronous file surface the writer needs: a SyncAccessHandle's shape. */
export interface SegmentFile {
  write(bytes: Uint8Array, at: number): number;
  flush(): void;
  getSize(): number;
  close(): void;
  /** Resolves once a write is visible to readers. Only the test fallback needs it. */
  settled?(): Promise<void>;
}

/** Creates a tab's segment files. In the browser, exclusive SyncAccessHandles. */
export interface SegmentStore {
  create(path: string): Promise<SegmentFile>;
}

/** A record to append: already stamped and numbered by the tab. */
export type OutFrame = {
  readonly stamp: Stamp;
  readonly n: number;
  readonly body: Uint8Array;
};

/**
 * Appends one tab's records to its own log. Only this tab ever opens these
 * files, so there is no lock, no scan for the end and no torn tail to
 * repair: a tab never reopens a log, a new tab starts a new one. A segment
 * is sealed and closed once it reaches `segmentBytes`; the next one starts
 * at the next write.
 *
 * After any call throws, every later write and flush throws too: the file
 * may hold part of a frame the offset does not count, and a record written
 * after it would follow a gap readers never cross.
 */
export class TabWriter {
  private file: SegmentFile | undefined;
  private offset = 0;
  private lastStamp: Stamp = 0;
  private lastN = 0;
  private dirty = false;
  private failed: unknown;

  constructor(
    private readonly store: SegmentStore,
    private readonly tab: TabId,
    private readonly segmentBytes: number,
  ) {}

  /** Create the next segment ahead of the write that needs it. */
  async prepare(): Promise<void> {
    if (this.file) return;
    const path = segmentPath(this.tab, { firstN: this.lastN + 1, prevStamp: this.lastStamp });
    this.file = await this.store.create(path);
    this.offset = this.file.getSize();
  }

  /** Write `frames` in one write. They are in the file, not yet durable. */
  async write(frames: readonly OutFrame[]): Promise<void> {
    if (this.failed !== undefined) throw this.failed;
    try {
      await this.writeFrames(frames);
    } catch (err) {
      this.failed = err;
      throw err;
    }
  }

  private async writeFrames(frames: readonly OutFrame[]): Promise<void> {
    if (frames.length === 0) return;
    if (!this.file) await this.prepare();
    const file = this.file!;
    const encoded = frames.map((f) => encodeFrame(KIND_RECORD, f.stamp, f.n, f.body));
    let total = 0;
    for (const f of encoded) total += f.byteLength;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const f of encoded) {
      bytes.set(f, at);
      at += f.byteLength;
    }
    file.write(bytes, this.offset);
    await file.settled?.();
    this.offset += total;
    const last = frames[frames.length - 1]!;
    this.lastStamp = last.stamp;
    this.lastN = last.n;
    this.dirty = true;
    if (this.offset >= this.segmentBytes) this.seal();
  }

  /** Make everything written so far durable. */
  flush(): void {
    if (this.failed !== undefined) throw this.failed;
    try {
      if (this.dirty && this.file) this.file.flush();
    } catch (err) {
      this.failed = err;
      throw err;
    }
    this.dirty = false;
  }

  private seal(): void {
    const file = this.file!;
    file.write(encodeFrame(KIND_SEAL, this.lastStamp, this.lastN, new Uint8Array(0)), this.offset);
    file.flush();
    file.close();
    this.file = undefined;
    this.dirty = false;
  }

  close(): void {
    this.flush();
    this.file?.close();
    this.file = undefined;
  }
}
