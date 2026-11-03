import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import { KeyOverlay } from "./store/overlay.js";

export interface ViewSnapshot {
  /** WAL head seq pinned when the view opened. */
  readonly walHead: number;
  /** OPFS generation pinned when the view opened. */
  readonly generation: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  range(range?: Range): AsyncIterable<Entry>;
}

export type PutEntry = { key: Uint8Array; value: Uint8Array };

function compareForRange(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lower bound index in a sorted put list. */
export function lowerBoundPuts(puts: readonly PutEntry[], key: Uint8Array): number {
  let lo = 0;
  let hi = puts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareForRange(puts[mid]!.key, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** WAL-over-SST live puts, sorted. Shared helper for Db cache and view pin. */
export function mergePuts(sst: KeyOverlay, wal: KeyOverlay): PutEntry[] {
  const merged = new KeyOverlay();
  for (const e of sst.entriesSorted()) {
    if (e.kind === "put") {
      merged.applyOps([
        { type: "put", key: e.key as never, value: e.value as never },
      ]);
    } else {
      merged.applyOps([{ type: "del", key: e.key as never }]);
    }
  }
  for (const e of wal.entriesSorted()) {
    if (e.kind === "put") {
      merged.applyOps([
        { type: "put", key: e.key as never, value: e.value as never },
      ]);
    } else {
      merged.applyOps([{ type: "del", key: e.key as never }]);
    }
  }
  const puts: PutEntry[] = [];
  for (const e of merged.entriesSorted()) {
    if (e.kind === "put") puts.push({ key: e.key, value: e.value });
  }
  return puts;
}

/** Pinned put list: shallow-copied so later Db cache rebuilds do not alias. */
export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;
  private readonly puts: PutEntry[];

  constructor(
    readonly walHead: number,
    readonly generation: number,
    puts: readonly PutEntry[],
  ) {
    this.puts = puts.slice();
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
    const k = checkKey(key);
    const i = lowerBoundPuts(this.puts, k);
    const hit = this.puts[i];
    if (!hit || !keysEqual(hit.key, k)) return undefined;
    return new Uint8Array(hit.value);
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const start = range?.start ? checkKey(range.start) : undefined;
    const end = range?.endExclusive
      ? checkKey(range.endExclusive)
      : undefined;
    let i = start ? lowerBoundPuts(this.puts, start) : 0;
    let n = 0;
    for (; i < this.puts.length; i++) {
      this.ensureOpen();
      const e = this.puts[i]!;
      if (end && compareForRange(e.key, end) >= 0) return;
      yield { key: new Uint8Array(e.key), value: new Uint8Array(e.value) };
      n++;
      if (range?.limit !== undefined && n >= range.limit) return;
    }
  }
}
