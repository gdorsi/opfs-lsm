import { Miss } from "./cursor.js";

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
  /**
   * Nonzero while the entry is pinned: eviction skips it until `fills`
   * reaches this. Set when a Miss filled it, cleared by the next lookup,
   * so the retry after `await miss.ready` always hits. The bound frees
   * entries whose retry never came.
   */
  pinnedUntil: number;
};

export const DEFAULT_BUDGET = 256 * 1024 * 1024;
const PROBATION_SHARE = 0.1;
const PIN_TTL_FILLS = 1024;

type CacheUsage = {
  readonly budget: number;
  /** Bytes of every resident entry, metadata included. */
  readonly resident: number;
  readonly metadata: number;
  /** Bytes eviction may not drop yet. `resident` exceeds `budget` only when all of it is pinned. */
  readonly pinned: number;
  /** Reads started and not landed. */
  readonly inFlight: number;
};

/**
 * The bytes of run files a tab holds, under one byte budget. S3-FIFO-lite:
 * a hit is one `Map.get` and a flag write. Eviction drops the probation
 * head unless it was hit (then it moves to main), and walks main and meta
 * as CLOCK queues.
 */
export class PageCache {
  private readonly entries = new Map<CacheKey, Entry>();
  private readonly loading = new Map<CacheKey, Promise<void>>();
  // Sets iterate in insertion order, so each is a FIFO with O(1) removal.
  private readonly queues: Record<Admit, Set<CacheKey>> = {
    probation: new Set(),
    main: new Set(),
    meta: new Set(),
  };
  private readonly queueBytes: Record<Admit, number> = { probation: 0, main: 0, meta: 0 };
  private resident = 0;
  private fills = 0;
  private runs = 0;

  constructor(readonly budget: number = DEFAULT_BUDGET) {}

  /** A fresh run id, so keys of a closed run never alias a new one. */
  nextRunId(): number {
    return this.runs++;
  }

  /**
   * The resident value, or a Miss whose load has started. Concurrent
   * lookups of one key share one load.
   */
  lookup<T>(key: CacheKey, admit: Admit, load: () => Promise<Sized<T>>): T | Miss {
    const e = this.entries.get(key);
    if (e) {
      // The retry after a fill is the same access as the miss, not a reuse.
      if (e.pinnedUntil !== 0) {
        e.pinnedUntil = 0;
        // Fills that landed together pinned each other past the budget, and no later fill may come.
        this.trim();
      } else e.hit = true;
      return e.value as T;
    }
    let p = this.loading.get(key);
    if (!p) {
      const started: Promise<void> = load().then(
        (s) => {
          if (this.loading.get(key) !== started) return;
          this.loading.delete(key);
          this.insert(key, s, admit);
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
    let pinned = 0;
    for (const e of this.entries.values()) if (this.isPinned(e)) pinned += e.bytes;
    return {
      budget: this.budget,
      resident: this.resident,
      metadata: this.queueBytes.meta,
      pinned,
      inFlight: this.loading.size,
    };
  }

  private insert(key: CacheKey, s: Sized<unknown>, admit: Admit): void {
    this.fills++;
    const e: Entry = { value: s.value, bytes: s.bytes, queue: admit, hit: false, pinnedUntil: this.fills + PIN_TTL_FILLS };
    this.entries.set(key, e);
    this.enqueue(key, e, admit);
    this.resident += s.bytes;
    this.trim();
  }

  private trim(): void {
    while (this.resident > this.budget && (this.evictPage() || this.evictFrom("meta"))) {}
  }

  private evictPage(): boolean {
    const probationFirst =
      this.queueBytes.probation > this.budget * PROBATION_SHARE || this.queues.main.size === 0;
    return probationFirst
      ? this.evictFrom("probation") || this.evictFrom("main")
      : this.evictFrom("main") || this.evictFrom("probation");
  }

  /**
   * Drops one unpinned entry from `queue`. A hit entry gets another round
   * instead (a probation hit moves to main). Two passes suffice: the first
   * clears every hit, so only pinned entries survive the second.
   */
  private evictFrom(queue: Admit): boolean {
    const q = this.queues[queue];
    for (let turns = 2 * q.size; turns > 0; turns--) {
      const key = q.values().next().value;
      if (key === undefined) return false;
      const e = this.entries.get(key)!;
      this.dequeue(key, e);
      if (this.isPinned(e)) {
        this.enqueue(key, e, queue);
      } else if (e.hit) {
        e.hit = false;
        this.enqueue(key, e, queue === "probation" ? "main" : queue);
      } else {
        this.entries.delete(key);
        this.resident -= e.bytes;
        return true;
      }
    }
    return false;
  }

  private isPinned(e: Entry): boolean {
    return e.pinnedUntil > this.fills;
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
