import type { CheckedOp } from "../check.js";
import type { Stamp, TabId } from "./frame.js";

/** A record waiting to become stable, or handed out stable. */
export type MergedRecord = {
  readonly stamp: Stamp;
  readonly tab: TabId;
  readonly n: number;
  readonly writerId: string;
  readonly ops: readonly CheckedOp[];
};

type TabState = {
  /** The last record taken in, by `n`; undefined until its log was read. */
  n: number | undefined;
  /** The tab writes nothing at or below this stamp from now on. */
  promise: Stamp;
  pending: MergedRecord[];
  /** The highest record stamp taken in. */
  top: Stamp;
  /** Its log was read to the end after its lock was released: it holds back nothing. */
  final: boolean;
};

/** What taking in a record did. "gap": records before it are missing; read the tab's log. */
export type Taken = "ok" | "dup" | "gap";

/**
 * One tab's merge of every tab's log. Pure: fed with records and promises
 * from broadcasts and log reads, it hands out the stable prefix.
 *
 * The order of all records is (stamp, tab). A tab's promise says it will
 * write nothing at or below a stamp. The watermark is the lowest promise
 * among the tabs that may still write: live tabs, and dead tabs whose log
 * has not been read to the end. A live tab this one has not heard from
 * yet holds it at −∞. Records at or below the watermark are stable: no
 * tab can write anything that sorts before them, so every tab hands out
 * the same prefix in the same order, and numbers it the same way.
 */
export class Merger {
  private readonly tabs = new Map<TabId, TabState>();
  private stableAt: Stamp = 0;

  constructor(readonly own: TabId) {}

  /** Every record at or below this stamp has been handed out or is in the installed generation. */
  get stable(): Stamp {
    return this.stableAt;
  }

  private state(tab: TabId): TabState {
    let st = this.tabs.get(tab);
    if (!st) {
      st = { n: undefined, promise: Number.NEGATIVE_INFINITY, pending: [], top: 0, final: false };
      this.tabs.set(tab, st);
    }
    return st;
  }

  /** The tabs this merger knows of, besides its own. */
  known(): TabId[] {
    return [...this.tabs.keys()].filter((t) => t !== this.own);
  }

  /** Whether another tab may still write and is waiting on this one. */
  othersLive(): boolean {
    for (const [tab, st] of this.tabs) if (tab !== this.own && !st.final) return true;
    return false;
  }

  isFinal(tab: TabId): boolean {
    return this.tabs.get(tab)?.final ?? false;
  }

  /**
   * Take in a record of `tab`. From a broadcast, its `n` must follow the
   * last one; from a log read (`fromLog`), the first record read may jump
   * over reclaimed segments. Their records are in a generation: the
   * session hands out nothing past them until its cut arrives.
   */
  record(tab: TabId, rec: MergedRecord, fromLog = false): Taken {
    const st = this.state(tab);
    if (st.final) return "dup";
    if (st.n !== undefined && rec.n <= st.n) return "dup";
    if (st.n === undefined ? !fromLog && rec.n !== 1 : rec.n !== st.n + 1 && !fromLog) return "gap";
    st.n = rec.n;
    if (rec.stamp > st.promise) st.promise = rec.stamp;
    if (rec.stamp > st.top) st.top = rec.stamp;
    if (rec.stamp > this.stableAt) st.pending.push(rec);
    return "ok";
  }

  /**
   * A log read reached the end of `tab`'s log at record `n` (0 for none)
   * with `stamp`, including records it passed over under the cut.
   */
  readTo(tab: TabId, n: number, stamp = 0): void {
    const st = this.state(tab);
    if (st.n === undefined || n > st.n) st.n = n;
    if (stamp > st.promise) st.promise = stamp;
    if (stamp > st.top) st.top = stamp;
  }

  /**
   * `tab` promises nothing at or below `stamp`, once its records through
   * `n` are in. "gap" when they are not: read its log, then promise again.
   */
  promise(tab: TabId, stamp: Stamp, n: number): Taken {
    const st = this.state(tab);
    if (st.final) return "dup";
    if (n > 0 && (st.n === undefined || st.n < n)) return "gap";
    if (st.n === undefined) st.n = 0;
    if (stamp > st.promise) st.promise = stamp;
    return "ok";
  }

  /** Make `tabs` the live tabs besides this one. A newly live tab holds the watermark until heard from. */
  setLive(tabs: Iterable<TabId>): void {
    for (const tab of tabs) if (tab !== this.own) this.state(tab);
  }

  /** `tab` is dead and its log was read to the end: it holds nothing back any more. */
  finalize(tab: TabId): void {
    const st = this.state(tab);
    st.final = true;
  }

  /** The lowest promise among tabs that may still write, capped at `ownPromise`. */
  watermark(ownPromise: Stamp): Stamp {
    let w = ownPromise;
    for (const [tab, st] of this.tabs) {
      if (tab === this.own || st.final) continue;
      if (st.promise < w) w = st.promise;
    }
    return w;
  }

  /** Hand out the records that became stable, in order, and move the stable stamp up. */
  drain(ownPromise: Stamp): MergedRecord[] {
    const w = this.watermark(ownPromise);
    if (w <= this.stableAt) return [];
    const out: MergedRecord[] = [];
    for (const st of this.tabs.values()) {
      let k = 0;
      while (k < st.pending.length && st.pending[k]!.stamp <= w) out.push(st.pending[k++]!);
      if (k > 0) st.pending.splice(0, k);
    }
    out.sort((a, b) => a.stamp - b.stamp || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0));
    this.stableAt = w;
    return out;
  }

  /** A generation holds every record at or below `cut`: drop them, and move the stable stamp to it. */
  cut(cut: Stamp): void {
    if (cut <= this.stableAt) return;
    this.stableAt = cut;
    for (const st of this.tabs.values()) {
      const k = st.pending.findIndex((r) => r.stamp > cut);
      st.pending.splice(0, k === -1 ? st.pending.length : k);
    }
  }

  /** The highest stamp waiting to become stable, or the stable stamp when none is. */
  maxPending(): Stamp {
    let top = this.stableAt;
    for (const st of this.tabs.values()) {
      const last = st.pending[st.pending.length - 1];
      if (last && last.stamp > top) top = last.stamp;
    }
    return top;
  }

  /** The highest record stamp taken in from another tab. */
  maxSeen(): Stamp {
    let top = this.stableAt;
    for (const [tab, st] of this.tabs) {
      if (tab !== this.own && st.top > top) top = st.top;
    }
    return top;
  }
}
