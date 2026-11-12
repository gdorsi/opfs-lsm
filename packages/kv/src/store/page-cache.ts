import { heldReads, Miss, type Fill } from "./cursor.js";

/**
 * `runId * 2^24 + slot`. A run's pages are slots from 0; its metadata is
 * `META_SLOT`. 2^24 pages of 32 KB cover any u32-addressed run file.
 */
type CacheKey = number;
const SLOTS = 0x1000000;
const META_SLOT = SLOTS - 1;

export function pageKey(runId: number, page: number): CacheKey {
  return runId * SLOTS + page;
}

export function metaKey(runId: number): CacheKey {
  return runId * SLOTS + META_SLOT;
}

/** A loaded value and the bytes it charges against the budget. */
export type Sized<T> = { readonly value: T; readonly bytes: number };

/**
 * Which queue a new entry enters. Point gets admit to `main`; scans to
 * `probation`, so one pass over the data cannot flush what gets reuse.
 * `meta` holds run metadata, evicted only when no page can be.
 */
export type Admit = "probation" | "main" | "meta";

type Entry = {
  readonly value: unknown;
  readonly bytes: number;
  queue: Admit;
  /** Touched since it entered its queue or was last passed over by eviction. */
  hit: boolean;
};

let runs = 0;

export const DEFAULT_BUDGET = 256 * 1024 * 1024;
const PROBATION_SHARE = 0.1;

type CacheUsage = {
  readonly budget: number;
  /** Bytes of every resident entry, metadata included. Never above `budget`. */
  readonly resident: number;
  readonly metadata: number;
  /** Reads started and not landed. */
  readonly inFlight: number;
};

/**
 * The bytes of run files a tab holds, under one byte budget. S3-FIFO-lite:
 * a hit is one `Map.get` and a flag write. Eviction drops the probation
 * head unless it was hit (then it moves to main), and walks main and meta
 * as CLOCK queues.
 *
 * Nothing here keeps an entry for a caller. A Miss hands the loaded value
 * to the operation, which holds it in its `ReadSet` and finds it there.
 */
export class PageCache {
  private readonly entries = new Map<CacheKey, Entry>();
  private readonly loading = new Map<CacheKey, Promise<readonly Fill[]>>();
  // Sets iterate in insertion order, so each is a FIFO with O(1) removal.
  private readonly queues: Record<Admit, Set<CacheKey>> = {
    probation: new Set(),
    main: new Set(),
    meta: new Set(),
  };
  private readonly queueBytes: Record<Admit, number> = { probation: 0, main: 0, meta: 0 };
  private resident = 0;

  constructor(readonly budget: number = DEFAULT_BUDGET) {}

  /**
   * A fresh run id. No other run has it, in this cache or another, so a
   * key names one value wherever it is held.
   */
  nextRunId(): number {
    return runs++;
  }

  /**
   * The resident value, or a Miss whose load has started. Concurrent
   * lookups of one key share one load.
   */
  lookup<T>(key: CacheKey, admit: Admit, load: () => Promise<Sized<T>>): T | Miss {
    const held = heldReads();
    const kept = held?.get(key);
    if (kept !== undefined) return kept as T;
    const e = this.entries.get(key);
    if (e) {
      e.hit = true;
      held?.set(key, e.value);
      return e.value as T;
    }
    let p = this.loading.get(key);
    if (!p) {
      const started: Promise<readonly Fill[]> = load().then(
        (s) => {
          if (this.loading.get(key) === started) {
            this.loading.delete(key);
            this.insert(key, s, admit);
          }
          return [[key, s.value]];
        },
        (err: unknown) => {
          if (this.loading.get(key) === started) this.loading.delete(key);
          throw err;
        },
      );
      p = started;
      this.loading.set(key, p);
    }
    return new Miss(p);
  }

  /** Drops a run's entries. Its loads still in flight land and are discarded. */
  dropRun(runId: number): void {
    const from = runId * SLOTS;
    const inRun = (key: CacheKey) => key >= from && key < from + SLOTS;
    for (const key of this.loading.keys()) if (inRun(key)) this.loading.delete(key);
    for (const [key, e] of this.entries) if (inRun(key)) this.remove(key, e);
  }

  usage(): CacheUsage {
    return {
      budget: this.budget,
      resident: this.resident,
      metadata: this.queueBytes.meta,
      inFlight: this.loading.size,
    };
  }

  /**
   * A value over the whole budget is not kept. Any other is counted before
   * it is queued, so eviction weighs its queue with it and cannot pick it.
   */
  private insert(key: CacheKey, s: Sized<unknown>, admit: Admit): void {
    if (s.bytes > this.budget) return;
    this.resident += s.bytes;
    this.queueBytes[admit] += s.bytes;
    while (this.resident > this.budget && (this.evictPage() || this.evictFrom("meta"))) {}
    this.entries.set(key, { value: s.value, bytes: s.bytes, queue: admit, hit: false });
    this.queues[admit].add(key);
  }

  private evictPage(): boolean {
    const probationFirst =
      this.queueBytes.probation > this.budget * PROBATION_SHARE || this.queues.main.size === 0;
    return probationFirst
      ? this.evictFrom("probation") || this.evictFrom("main")
      : this.evictFrom("main") || this.evictFrom("probation");
  }

  /**
   * Drops one entry from `queue`, false when it is empty. A hit entry gets
   * another round instead (a probation hit moves to main), with its hit
   * cleared, so the walk ends.
   */
  private evictFrom(queue: Admit): boolean {
    const q = this.queues[queue];
    for (;;) {
      const key = q.values().next().value;
      if (key === undefined) return false;
      const e = this.entries.get(key)!;
      this.dequeue(key, e);
      if (!e.hit) {
        this.entries.delete(key);
        this.resident -= e.bytes;
        return true;
      }
      e.hit = false;
      this.enqueue(key, e, queue === "probation" ? "main" : queue);
    }
  }

  private enqueue(key: CacheKey, e: Entry, queue: Admit): void {
    e.queue = queue;
    this.queues[queue].add(key);
    this.queueBytes[queue] += e.bytes;
  }

  private dequeue(key: CacheKey, e: Entry): void {
    this.queues[e.queue].delete(key);
    this.queueBytes[e.queue] -= e.bytes;
  }

  private remove(key: CacheKey, e: Entry): void {
    this.dequeue(key, e);
    this.entries.delete(key);
    this.resident -= e.bytes;
  }
}
