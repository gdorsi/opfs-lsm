import { opsBytes, type CheckedOp } from "../check.js";
import { ClosedError } from "../errors.js";
import { layersChannel, logChannel } from "../host/protocol.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { Memtable, type MemRows } from "../store/memtable.js";
import type { TabLogClient } from "./client.js";
import { encodeOps, type Stamp, type TabId } from "./frame.js";
import { Hlc } from "./hlc.js";
import { holdTab, liveTabs } from "./liveness.js";
import { Merger, type MergedRecord, type Taken } from "./merger.js";
import { TAB_START, listTabs, readTab, type TabPos } from "./reader.js";

/**
 * The messages sessions exchange on `logChannel`. A `rec` goes out once the
 * record is durable in its tab's log, and doubles as a promise of its
 * stamp. `n` is the sender's last record sent, so a receiver that missed
 * one reads the sender's log.
 */
type LogMessage =
  | {
      readonly kind: "rec";
      readonly tab: TabId;
      readonly stamp: Stamp;
      readonly n: number;
      readonly writerId: string;
      readonly ops: readonly CheckedOp[];
    }
  | { readonly kind: "promise"; readonly tab: TabId; readonly stamp: Stamp; readonly n: number }
  /** `again`: a stalled tab asking once more, so the last promise may have been lost. */
  | { readonly kind: "advance"; readonly tab: TabId; readonly stamp: Stamp; readonly again?: boolean }
  | { readonly kind: "hello"; readonly tab: TabId }
  | {
      readonly kind: "welcome";
      readonly tab: TabId;
      readonly to: TabId;
      readonly stable: Stamp;
      readonly promise: Stamp;
      readonly n: number;
    }
  | { readonly kind: "bye"; readonly tab: TabId; readonly n: number };

/** How often a stalled session asks again and checks for dead tabs, in ms. */
const RETRY_MS = 50;
/** How long written records wait for a flush while other tabs are live, and while alone, in ms. */
const FLUSH_SOON_MS = 2;
const FLUSH_ALONE_MS = 100;

/** This tab's records that are in its log and not yet stable, read over the stable memtable. */
class Overlay {
  private recs: { stamp: Stamp; ops: readonly CheckedOp[] }[] = [];
  private table = new Memtable();

  get rows(): Memtable {
    return this.table;
  }

  get empty(): boolean {
    return this.recs.length === 0;
  }

  get maxStamp(): Stamp {
    return this.recs[this.recs.length - 1]?.stamp ?? 0;
  }

  add(stamp: Stamp, ops: readonly CheckedOp[]): void {
    this.recs.push({ stamp, ops });
    this.table.apply({ seq: this.table.appliedThrough + 1, ops });
  }

  /** Drop the records at or below `stamp`: they are in the stable memtable or a generation now. */
  dropThrough(stamp: Stamp): void {
    if (this.recs.length === 0 || this.recs[0]!.stamp > stamp) return;
    this.recs = this.recs.filter((r) => r.stamp > stamp);
    this.table = new Memtable();
    for (const r of this.recs) this.table.apply({ seq: this.table.appliedThrough + 1, ops: r.ops });
  }
}

export type SessionOptions = {
  readonly name: string;
  readonly tab: TabId;
  /** This tab's liveness lock, requested by the caller; requested here when absent. */
  readonly held?: Promise<() => void>;
  readonly fs: AsyncFs;
  readonly client: TabLogClient;
  /** Records that became stable, in order. The caller numbers them on from its memtable. */
  readonly onStable: (records: readonly MergedRecord[]) => void;
  /** Ask for an ingest once this many op bytes became stable since the last cut. */
  readonly maxWalBytes: number;
  /**
   * A log read found records through `through`, above the stable stamp,
   * reclaimed: they are in a generation only. Install the newest one;
   * nothing is handed out until a `cut` through them arrives. If the
   * newest has none, call `corrupt`.
   */
  readonly onBehind?: (through: Stamp) => void;
  /**
   * A dead tab's log is gone: reclaim removed it whole, so the committed
   * generation holds whatever it wrote. Install the newest generation;
   * the tab holds the watermark until this resolves.
   */
  readonly onGone?: () => Promise<void>;
};

/** An `update` holding stamp `stamp`: everything below it is stable and nothing above it is. */
export type Reservation = {
  readonly stamp: Stamp;
  commit(ops: readonly CheckedOp[], writerId: string): Promise<void>;
  done(): void;
};

/**
 * One tab's side of the per-tab log protocol (architecture/wal-opfs/04).
 *
 * Writes go to the tab's own log with no lock and resolve once written;
 * the tab reads them at once through the overlay. Once durable they are
 * broadcast. Other tabs' records become visible when the merger's
 * watermark passes them, in the one order every tab agrees on.
 */
export class LogSession {
  private readonly hlc = new Hlc();
  merger: Merger;
  /** Log reads pass over records at or below this, besides the stable ones: the cut open expects. */
  private readFloor: Stamp | Promise<Stamp> = 0;
  private readonly overlay = new Overlay();
  private readonly bus: BroadcastChannel | undefined;
  /** Where ingest requests go to the host; this session never listens on it. */
  private readonly layers: BroadcastChannel | undefined;
  private release: (() => void) | undefined;
  /** The log failed and this tab said goodbye: it posts nothing more. */
  private left = false;
  private holding: Promise<void> | undefined;
  private closed = false;
  /** No record is handed out before join: their seqs count on from the installed generation. */
  private joined = false;
  private failed: unknown;

  /** The last `n` this tab gave a record. */
  private nextN = 0;
  /** Stamps appended and not yet written, oldest first. */
  private unacked: Stamp[] = [];
  /** Records written and not yet durable and broadcast, oldest first. */
  private unsent: MergedRecord[] = [];
  /** The `update` stamp held, if any. */
  private reservation: Stamp | undefined;
  private updating: Promise<void> | undefined;
  private lastWrite: Promise<unknown> = Promise.resolve();
  /** The highest stamp other tabs were promised, and the last `n` sent with it. */
  private sentStamp: Stamp = 0;
  private sentN = 0;
  /** The highest stamp another tab asked this one to promise. */
  private othersWant: Stamp = 0;

  private readonly pos = new Map<TabId, TabPos>();
  private readonly reading = new Map<TabId, Promise<boolean>>();
  private waiters: { target: Stamp; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private requested: Stamp = 0;
  /** Records at or below this were reclaimed before this tab saw them: wait for a cut through it. */
  private needCut: Stamp = 0;
  /** The next `advance` is a retry. */
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private joining: { expect: Set<TabId>; done: () => void } | undefined;
  /** Stable records above the generation's cut: their stamps and bytes, oldest first. */
  private stableRecs: { stamp: Stamp; bytes: number }[] = [];
  private stableBytes = 0;
  /** The stable bytes when the last ingest request went out, 0 once a cut answered it. */
  private askedAt = 0;

  constructor(private readonly opts: SessionOptions) {
    this.merger = new Merger(opts.tab);
    if (typeof BroadcastChannel !== "undefined") {
      this.layers = new BroadcastChannel(layersChannel(opts.name));
      this.bus = new BroadcastChannel(logChannel(opts.name));
      this.bus.onmessage = (ev: MessageEvent<LogMessage | null>) => {
        if (ev.data) this.onMessage(ev.data);
      };
    }
  }

  get tab(): TabId {
    return this.opts.tab;
  }

  /** This tab's unstable records, to read over the stable memtable; undefined when there are none. */
  get ownRows(): MemRows | undefined {
    return this.overlay.empty ? undefined : this.overlay.rows;
  }

  pinOwnRows(): MemRows | undefined {
    return this.overlay.empty ? undefined : this.overlay.rows.pin();
  }

  /** Take this tab's liveness lock. Open calls it first; `prepareJoin` waits for it. */
  hold(): Promise<void> {
    this.holding ??= (this.opts.held ?? holdTab(this.opts.name, this.tab)).then((release) => {
      this.release = release;
    });
    return this.holding;
  }

  /**
   * The half of joining the tabs that needs no generation: hold the liveness lock and
   * read every log, at once, passing over records at or below `floor`. Open
   * runs it while it reads the manifest and loads the generation; `floor`
   * is awaited only once the log bytes are in. Records stay in the merger until
   * `finishJoin`.
   *
   * Then the live tabs (`dead`).
   */
  async prepareJoin(floor: Stamp | Promise<Stamp> = 0): Promise<void> {
    this.readFloor = floor;
    await Promise.all([this.hold(), this.readAll()]);
    const { live, dead } = await this.liveAndDead();
    this.merger.setLive(live);
    await Promise.all(dead.map((t) => this.retire(t)));
  }

  /**
   * The live tabs, and the known tabs that are dead. Only a tab known
   * before the query counts as dead when the query misses it: a tab holds
   * its lock before any other tab can know of it, so it released the lock,
   * and its log is final. A tab that became known while the query was out
   * (its hello, a record) may have taken its lock after the snapshot.
   */
  private async liveAndDead(): Promise<{ live: Set<TabId>; dead: TabId[] }> {
    const known = this.merger.known();
    const live = await liveTabs(this.opts.name);
    live.delete(this.tab);
    return { live, dead: known.filter((t) => !live.has(t)) };
  }

  /**
   * Before `finishJoin` only: forget what the logs held and read them again
   * above `floor`. For an open that expected a generation and fell back to
   * an older one, whose cut is lower.
   */
  async rejoin(floor: Stamp): Promise<void> {
    this.merger = new Merger(this.opts.tab);
    this.pos.clear();
    await this.prepareJoin(floor);
  }

  /** The rest of joining, once a generation is installed: agree on a start with each live tab. */
  async finishJoin(): Promise<void> {
    const live = this.merger.known().filter((t) => !this.merger.isFinal(t));
    if (live.length > 0) {
      await new Promise<void>((done) => {
        this.joining = { expect: new Set(live), done };
        this.post({ kind: "hello", tab: this.tab });
        this.armTimer();
      });
      this.joining = undefined;
    }
    // Announce: until now every other tab held its watermark below this tab.
    this.joined = true;
    this.sentStamp = this.hlc.last;
    this.post({ kind: "promise", tab: this.tab, stamp: this.sentStamp, n: 0 });
    this.pump();
  }

  private post(msg: LogMessage): void {
    if (!this.closed && !this.left) this.bus?.postMessage(msg);
  }

  private onMessage(msg: LogMessage): void {
    if (this.closed) return;
    switch (msg.kind) {
      case "rec":
        if (msg.tab === this.tab) return;
        this.hlc.observe(msg.stamp);
        this.took(msg.tab, this.merger.record(msg.tab, { stamp: msg.stamp, tab: msg.tab, n: msg.n, writerId: msg.writerId, ops: msg.ops }));
        return;
      case "promise":
        if (msg.tab === this.tab) return;
        this.promised(msg.tab, msg.stamp, msg.n);
        return;
      case "advance":
        if (msg.stamp > this.othersWant) this.othersWant = msg.stamp;
        // A promise that went out and was lost is not in any log: send it
        // again, even when this tab can promise no more yet.
        if (msg.again && this.joined) {
          this.post({ kind: "promise", tab: this.tab, stamp: this.sentStamp, n: this.sentN });
        }
        this.answer();
        return;
      case "hello":
        if (msg.tab === this.tab) return;
        // Hold the watermark below the newcomer until it promises, and tell
        // it what to start above.
        this.merger.setLive([msg.tab]);
        this.post({
          kind: "welcome",
          tab: this.tab,
          to: msg.tab,
          stable: Math.max(this.merger.stable, this.hlc.last),
          promise: this.sentStamp,
          n: this.sentN,
        });
        return;
      case "welcome":
        if (msg.to !== this.tab || !this.joining) return;
        this.hlc.observe(msg.stable);
        this.promised(msg.tab, msg.promise, msg.n);
        this.joining.expect.delete(msg.tab);
        if (this.joining.expect.size === 0) this.joining.done();
        return;
      case "bye":
        if (msg.tab !== this.tab) void this.retire(msg.tab);
        return;
    }
  }

  private took(tab: TabId, taken: Taken): void {
    if (taken === "gap") void this.read(tab).then(() => this.pump());
    else if (taken === "ok") this.pump();
  }

  private promised(tab: TabId, stamp: Stamp, n: number): void {
    if (this.merger.promise(tab, stamp, n) === "gap") {
      void this.read(tab).then(() => {
        this.merger.promise(tab, stamp, n);
        this.pump();
      });
    } else {
      this.pump();
    }
  }

  /** Read `tab`'s log on from where the last read stopped. One read per tab at a time. */
  /** Read `tab`'s log from where the last read stopped. Resolves true when the tab has no log left. */
  private read(tab: TabId): Promise<boolean> {
    const running = this.reading.get(tab);
    if (running) return running.then(() => this.read(tab));
    const run = (async () => {
      // Records at or below the stable stamp are handed out or in a generation already.
      const skip = Promise.resolve(this.readFloor).then((f) => Math.max(this.merger.stable, f));
      const got = await readTab(this.opts.fs, tab, this.pos.get(tab) ?? TAB_START, skip);
      if (got.reclaimed > this.merger.stable && got.reclaimed > this.needCut) {
        this.needCut = got.reclaimed;
        this.opts.onBehind?.(got.reclaimed);
      }
      for (const r of got.records) {
        this.hlc.observe(r.stamp);
        this.merger.record(tab, { stamp: r.stamp, tab, n: r.n, writerId: tab, ops: r.ops }, true);
      }
      if (got.pos.n !== undefined) this.merger.readTo(tab, got.pos.n, got.pos.stamp);
      this.pos.set(tab, got.pos);
      return got.empty;
    })();
    this.reading.set(tab, run);
    return run.finally(() => {
      if (this.reading.get(tab) === run) this.reading.delete(tab);
    });
  }

  /** Read every tab's log to its end. */
  async readAll(): Promise<void> {
    const tabs = await listTabs(this.opts.fs);
    await Promise.all(tabs.filter((t) => t !== this.tab).map((t) => this.read(t)));
    this.pump();
  }

  /**
   * `tab` closed or died: read the rest of its log, then stop waiting for
   * it. With no log left, it may have written records this tab never saw
   * that a generation now holds: install the newest first. A failed
   * install leaves the tab waited for, and the next tick retires it again.
   */
  private async retire(tab: TabId): Promise<void> {
    if (this.merger.isFinal(tab)) return;
    if (await this.read(tab)) {
      try {
        await this.opts.onGone?.();
      } catch {
        return;
      }
      if (this.closed || this.merger.isFinal(tab)) return;
    }
    this.merger.finalize(tab);
    this.pump();
  }

  /** The stamp below which this tab has nothing in flight, for its own watermark. */
  private ownPromise(): Stamp {
    if (this.reservation !== undefined) return this.reservation - 1;
    if (this.unacked.length > 0) return this.unacked[0]! - 1;
    return this.hlc.last;
  }

  /** Promise other tabs as much as is durable and sent, up to what they asked for. */
  private answer(): void {
    if (this.othersWant <= this.sentStamp) return;
    const first = this.unsent[0];
    if (first && first.stamp <= this.othersWant) this.scheduleFlush(true);
    const pending = [this.reservation, this.unacked[0], this.unsent[0]?.stamp].filter(
      (s): s is Stamp => s !== undefined,
    );
    let p: Stamp;
    if (pending.length > 0) {
      p = Math.min(...pending) - 1;
    } else {
      this.hlc.observe(this.othersWant);
      p = this.hlc.last;
    }
    if (p <= this.sentStamp) return;
    this.sentStamp = p;
    this.post({ kind: "promise", tab: this.tab, stamp: p, n: this.sentN });
  }

  /** Hand out what became stable, wake waiters, and ask laggards to move. */
  private pump(): void {
    if (this.closed || !this.joined) return;
    // Behind a reclaim: what follows the records it removed waits for their generation.
    const behind = this.needCut > this.merger.stable;
    const recs = this.merger.drain(behind ? this.merger.stable : this.ownPromise());
    if (recs.length > 0) {
      this.opts.onStable(recs);
      for (const r of recs) {
        const bytes = opsBytes(r.ops);
        this.stableRecs.push({ stamp: r.stamp, bytes });
        this.stableBytes += bytes;
      }
    }
    this.askIngest();
    this.overlay.dropThrough(this.merger.stable);
    const stable = this.merger.stable;
    if (this.waiters.length > 0) {
      const ready = this.waiters.filter((w) => w.target <= stable);
      this.waiters = this.waiters.filter((w) => w.target > stable);
      for (const w of ready) w.resolve();
    }
    let need = Math.max(this.merger.maxPending(), this.overlay.maxStamp);
    for (const w of this.waiters) need = Math.max(need, w.target);
    if (need > stable) {
      if (need > this.requested) {
        this.requested = need;
        this.post({ kind: "advance", tab: this.tab, stamp: need, ...(this.again ? { again: true } : {}) });
      }
      this.armTimer();
    } else if (!this.joining) {
      this.disarmTimer();
    }
  }

  private armTimer(): void {
    if (this.timer || this.closed || this.left) return;
    this.timer = setInterval(() => void this.tick(), RETRY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private disarmTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stalled: retire tabs that died, wait for tabs that joined, and ask again. */
  private async tick(): Promise<void> {
    if (this.closed) return;
    const { live, dead } = await this.liveAndDead();
    this.merger.setLive(live);
    for (const tab of dead) await this.retire(tab);
    if (this.joining) {
      for (const tab of dead) this.joining.expect.delete(tab);
      if (this.joining.expect.size === 0) this.joining.done();
      else this.post({ kind: "hello", tab: this.tab });
    }
    if (this.needCut > this.merger.stable) this.opts.onBehind?.(this.needCut);
    this.requested = 0;
    this.again = true;
    this.pump();
    this.again = false;
  }

  /**
   * This tab's log failed (a write or flush threw, e.g. out of quota). It
   * can't continue past a lost record, so every later write fails too. It
   * also can't promise past what it wrote, which would hold every other
   * tab's watermark forever: it leaves, as on close, and the others retire
   * it, reading its log to its end.
   */
  private logFailed(err: unknown): void {
    if (this.failed !== undefined) return;
    this.failed = err;
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.disarmTimer();
    this.post({ kind: "bye", tab: this.tab, n: this.sentN });
    this.left = true;
    void this.holding?.then(
      () => this.releaseTab(),
      () => undefined,
    );
  }

  private releaseTab(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  /** The logs lost records no generation holds: every wait and write fails with `err` from now on. */
  corrupt(err: Error): void {
    this.failed ??= err;
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }

  /** Resolve once every record at or below `target` is stable here. */
  waitStable(target: Stamp): Promise<void> {
    if (this.merger.stable >= target) return Promise.resolve();
    if (this.closed) return Promise.reject(new ClosedError("database is closed"));
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiters.push({ target, resolve, reject });
      this.pump();
    });
  }

  /**
   * Read every log, and wait until every record seen from another tab, and
   * every record this tab wrote, is stable: what reads see after it is one
   * prefix of the order, with nothing of this tab's on top.
   */
  async catchUp(): Promise<void> {
    const own = this.overlay.maxStamp;
    await this.readAll();
    await this.waitStable(Math.max(this.merger.maxSeen(), own));
  }

  /**
   * Append `ops` with no lock. Resolves once written, with its stamp; this
   * tab reads it at once.
   */
  async append(
    ops: readonly CheckedOp[],
    writerId: string,
    stamped?: (stamp: Stamp) => void,
  ): Promise<Stamp> {
    while (this.updating) await this.updating;
    const stamp = this.hlc.next();
    stamped?.(stamp);
    await this.appendAt(stamp, ops, writerId);
    return stamp;
  }

  private async appendAt(stamp: Stamp, ops: readonly CheckedOp[], writerId: string): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.closed) throw new ClosedError("database is closed");
    const n = ++this.nextN;
    this.unacked.push(stamp);
    const written = this.opts.client.append({ stamp, n, body: encodeOps(ops) });
    this.lastWrite = written;
    try {
      await written;
    } catch (err) {
      this.logFailed(err);
      throw err;
    } finally {
      this.unacked.splice(this.unacked.indexOf(stamp), 1);
    }
    // An earlier record failed while this one was written: this tab left,
    // and the others read its log only to the record before the failure.
    if (this.failed) throw this.failed;
    const rec: MergedRecord = { stamp, tab: this.tab, n, writerId, ops };
    this.merger.record(this.tab, rec);
    this.unsent.push(rec);
    this.pump();
    if (stamp > this.merger.stable) this.overlay.add(stamp, ops);
    this.scheduleFlush();
  }

  /**
   * Flushes cost far more than writes (a SyncAccessHandle flush is ~0.4 ms
   * in Chrome and blocks the next write), so they run only when needed: at
   * once when another tab waits on a record not yet durable, soon when
   * other tabs are live so they see the writes, and lazily when alone.
   * One flush at a time covers every record written before it starts.
   * Records are broadcast only once durable, so a power loss never leaves
   * another tab ahead of this log.
   */
  private flushing: Promise<void> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushUrgent = false;

  private scheduleFlush(urgent = false): void {
    if (this.unsent.length === 0 || this.closed || this.left) return;
    if (this.flushing) {
      this.flushUrgent ||= urgent;
      return;
    }
    if (urgent) {
      this.startFlush();
      return;
    }
    if (this.flushTimer) return;
    const ms = this.merger.othersLive() ? FLUSH_SOON_MS : FLUSH_ALONE_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.flushing) this.startFlush();
    }, ms);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  private startFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushUrgent = false;
    // Only records already written: a flush may overtake appends still batching.
    const through = this.unsent[this.unsent.length - 1]?.n ?? 0;
    this.flushing = this.opts.client.flush().then(
      () => {
        this.flushing = undefined;
        this.sent(through);
        this.scheduleFlush(this.flushUrgent);
      },
      (err) => {
        this.flushing = undefined;
        this.logFailed(err);
      },
    );
  }

  /**
   * Make every record appended so far durable and broadcast. Records
   * appended after the call are not waited for: a tab that keeps writing
   * never empties `unsent`.
   */
  private async flushAll(): Promise<void> {
    const through = this.nextN;
    await this.lastWrite.catch(() => undefined);
    while (this.unsent.length > 0 && this.unsent[0]!.n <= through) {
      if (this.failed) throw this.failed;
      if (!this.flushing) this.startFlush();
      await this.flushing;
    }
  }

  /** Records through `n` are durable: broadcast them. */
  private sent(n: number): void {
    while (this.unsent.length > 0 && this.unsent[0]!.n <= n) {
      const rec = this.unsent.shift()!;
      this.post({ kind: "rec", tab: this.tab, stamp: rec.stamp, n: rec.n, writerId: rec.writerId, ops: rec.ops });
      if (rec.stamp > this.sentStamp) this.sentStamp = rec.stamp;
      this.sentN = rec.n;
    }
    this.answer();
    this.askIngest();
  }

  /**
   * For `update`: wait for this tab's writes, take the next stamp, and wait
   * until every record below it is stable. Nothing above it becomes stable
   * until `done`, so the caller reads exactly the state before its stamp.
   */
  async reserve(): Promise<Reservation> {
    while (this.updating) await this.updating;
    let finish!: () => void;
    this.updating = new Promise((r) => (finish = r));
    let held = true;
    const done = () => {
      if (!held) return;
      held = false;
      this.reservation = undefined;
      this.updating = undefined;
      finish();
      this.answer();
      this.pump();
    };
    try {
      await this.lastWrite.catch(() => undefined);
      const stamp = this.hlc.next();
      this.reservation = stamp;
      await this.waitStable(stamp - 1);
      return {
        stamp,
        commit: async (ops, writerId) => {
          // appendAt lists the stamp as unacked before this returns to the
          // event loop, so the watermark never passes it in between.
          this.reservation = undefined;
          await this.appendAt(stamp, ops, writerId);
        },
        done,
      };
    } catch (err) {
      done();
      throw err;
    }
  }

  /**
   * A stamp through which every record is stable here and durable in its
   * log, for an ingest cut. Waits for this tab's writes to be durable and
   * for every record seen to be stable.
   */
  async stableCut(): Promise<Stamp> {
    await this.flushAll();
    await this.readAll();
    const own = this.unsent[this.unsent.length - 1]?.stamp ?? 0;
    await this.waitStable(Math.max(this.merger.maxSeen(), own, this.overlay.maxStamp));
    return this.ingestCut();
  }

  private ingestCut(): Stamp {
    const durable = this.unsent[0] ? this.unsent[0].stamp - 1 : Number.POSITIVE_INFINITY;
    const written = this.unacked[0] !== undefined ? this.unacked[0] - 1 : Number.POSITIVE_INFINITY;
    return Math.min(this.merger.stable, durable, written);
  }

  /**
   * Once the stable records pass `maxWalBytes`, ask the host to ingest
   * through the newest of them. The cut must include it, so this tab's own
   * records are made durable first. With no cut since, it asks again only
   * once another `maxWalBytes` waits: a lost request or a failed ingest is
   * retried without hammering the host.
   */
  private askIngest(): void {
    if (this.stableBytes < this.askedAt + this.opts.maxWalBytes) return;
    const due = this.stableRecs[this.stableRecs.length - 1]!.stamp;
    if (this.unsent[0] && this.unsent[0].stamp <= due) {
      this.scheduleFlush(true);
      return;
    }
    this.askedAt = this.stableBytes;
    if (!this.closed) this.layers?.postMessage({ kind: "ingest-request", cut: this.ingestCut() });
  }

  /** A generation holds every record at or below `cut`. */
  cut(cut: Stamp): void {
    this.hlc.observe(cut);
    this.merger.cut(cut);
    this.overlay.dropThrough(cut);
    let i = 0;
    while (i < this.stableRecs.length && this.stableRecs[i]!.stamp <= cut) this.stableBytes -= this.stableRecs[i++]!.bytes;
    this.stableRecs.splice(0, i);
    if (i > 0) this.askedAt = 0;
    this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await Promise.race([
      this.flushAll().catch(() => undefined),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.post({ kind: "bye", tab: this.tab, n: this.sentN });
    this.closed = true;
    this.disarmTimer();
    for (const w of this.waiters) w.reject(new ClosedError("database is closed"));
    this.waiters = [];
    this.joining?.done();
    this.bus?.close();
    this.layers?.close();
    await this.opts.client.close().catch(() => undefined);
    await this.holding?.catch(() => undefined);
    this.releaseTab();
  }
}
