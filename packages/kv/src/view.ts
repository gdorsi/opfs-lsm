import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import { KeyOverlay, resolveGet } from "./store/overlay.js";

export interface ViewSnapshot {
  /** WAL head seq pinned when the view opened. */
  readonly walHead: number;
  /** OPFS generation pinned when the view opened. */
  readonly generation: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  range(range?: Range): AsyncIterable<Entry>;
}

function cloneOverlay(src: KeyOverlay): KeyOverlay {
  const out = new KeyOverlay();
  out.applyOps(
    src.entriesSorted().map((e) =>
      e.kind === "put"
        ? {
            type: "put" as const,
            key: e.key as never,
            value: e.value as never,
          }
        : { type: "del" as const, key: e.key as never },
    ),
  );
  return out;
}

function compareForRange(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;
  private readonly wal: KeyOverlay;
  private readonly sst: KeyOverlay;

  constructor(
    readonly walHead: number,
    readonly generation: number,
    wal: KeyOverlay,
    sst: KeyOverlay,
  ) {
    this.wal = cloneOverlay(wal);
    this.sst = cloneOverlay(sst);
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("view snapshot is closed");
  }

  /** Release after the view callback settles. */
  close(): void {
    this.closed = true;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    return resolveGet(checkKey(key), this.wal, this.sst);
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const merged = new KeyOverlay();
    merged.applyOps(
      this.sst.entriesSorted().map((e) =>
        e.kind === "put"
          ? {
              type: "put" as const,
              key: e.key as never,
              value: e.value as never,
            }
          : { type: "del" as const, key: e.key as never },
      ),
    );
    merged.applyOps(
      this.wal.entriesSorted().map((e) =>
        e.kind === "put"
          ? {
              type: "put" as const,
              key: e.key as never,
              value: e.value as never,
            }
          : { type: "del" as const, key: e.key as never },
      ),
    );
    const start = range?.start ? checkKey(range.start) : undefined;
    const end = range?.endExclusive
      ? checkKey(range.endExclusive)
      : undefined;
    let n = 0;
    for (const e of merged.entriesSorted()) {
      this.ensureOpen();
      if (e.kind === "del") continue;
      if (start && compareForRange(e.key, start) < 0) continue;
      if (end && compareForRange(e.key, end) >= 0) continue;
      yield { key: new Uint8Array(e.key), value: new Uint8Array(e.value!) };
      n++;
      if (range?.limit !== undefined && n >= range.limit) return;
    }
  }
}
