import type { Env, SaveState } from "./types.ts";

const AUTOSAVE_MS = 400;
const SAVED: SaveState = { kind: "saved" };
const SAVING: SaveState = { kind: "saving" };

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * The save state of one doc. `touch` says an update reached storage's queue, `flush` asks storage to ack it.
 *
 *   saved --touch--> saving --flush resolves--> saved
 *   saving --flush rejects--> error --flush resolves--> saved
 *
 * With `everyMs` set, a flush runs that long after the first update, and again while updates keep coming (a
 * continuous drag is flushed during the drag). After an error it retries on the same period, so a storage that
 * recovers reaches `saved` by itself. The state stays `error` until a flush resolves.
 */
export class Saver {
  private current: SaveState = SAVED;
  private dirty = false;
  private flushing: Promise<void> | undefined;
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private readonly storage: { flush(): Promise<void> };
  private readonly schedule: Env["schedule"];
  private readonly everyMs: number | null;
  private readonly onChange: () => void;

  /** `everyMs`: the autosave period. Undefined is 400. Null never flushes by itself. */
  constructor(
    storage: { flush(): Promise<void> },
    schedule: Env["schedule"],
    everyMs: number | null | undefined,
    onChange: () => void,
  ) {
    this.storage = storage;
    this.schedule = schedule;
    this.everyMs = everyMs === undefined ? AUTOSAVE_MS : everyMs;
    this.onChange = onChange;
  }

  state(): SaveState {
    return this.current;
  }

  /** An update reached the doc, so storage has one more write to ack. */
  touch(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.current.kind === "saved") this.set(SAVING);
    this.arm();
  }

  /** Resolves when storage has acked everything so far. Rejects with the storage's error. */
  flush(): Promise<void> {
    this.disarm();
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
      if (this.dirty) this.arm();
    });
    return this.flushing;
  }

  close(): void {
    this.closed = true;
    this.disarm();
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.dirty = false;
        await this.storage.flush();
      } while (this.dirty);
    } catch (error) {
      this.dirty = true;
      this.set({ kind: "error", error: toError(error) });
      throw error;
    }
    this.set(SAVED);
  }

  private arm(): void {
    if (this.everyMs === null || this.closed || this.cancelTimer || this.flushing) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      this.flush().catch(() => {});
    }, this.everyMs);
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private set(next: SaveState): void {
    if (this.closed || next === this.current) return;
    this.current = next;
    this.onChange();
  }
}
