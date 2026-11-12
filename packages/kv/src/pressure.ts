import type { Offer, Pressure } from "./host/cap.js";
import type { IngestClient } from "./host/protocol.js";
import { pressureLock, webLocks } from "./locks.js";

/** Removes about `pressure.need` entry bytes with ordinary writes. See `Db.onPressure`. */
export type PressureHandler = (pressure: Pressure) => Promise<void>;

/**
 * The tab's stake in the pressure lock. `asking` waits in the lock's queue
 * behind the tab that answers now.
 */
type Lock =
  | { readonly kind: "free" }
  | { readonly kind: "asking" | "holding"; readonly release: () => void };

const FREE: Lock = { kind: "free" };

/** The offer whose handlers run. `abandoned` once the tab let go of the lock mid-run: it sends no answer. */
type Run = { readonly id: string; abandoned: boolean };

/**
 * Every handle of one database in one tab that was opened with `maxBytes`.
 * The tab asks for the pressure lock while any of them has a handler, and
 * the holder runs every handler of the tab, one after another, once per
 * offer. A tab with no handler warns once per offer when no tab holds the
 * lock.
 */
class PressureTab {
  readonly members = new Set<PressureMember>();
  private lock: Lock = FREE;
  private run: Run | undefined;
  /** An offer that arrived during a run, answered after it. */
  private queued: Offer | undefined;
  private answered: string | undefined;
  private warned: string | undefined;

  constructor(
    private readonly key: string,
    readonly name: string,
  ) {}

  private handlers(): number {
    let n = 0;
    for (const m of this.members) n += m.handlers.size;
    return n;
  }

  private client(): IngestClient | undefined {
    return this.members.values().next().value?.ingest;
  }

  offer(offer: Offer): void {
    if (this.handlers() === 0) {
      if (offer.id !== this.warned) {
        this.warned = offer.id;
        this.probe(offer.pressure);
      }
      return;
    }
    if (offer.id === this.answered || offer.id === this.run?.id || this.lock.kind !== "holding") return;
    if (this.run) this.queued = offer;
    else void this.answer(offer);
  }

  private async answer(offer: Offer): Promise<void> {
    const run: Run = { id: offer.id, abandoned: false };
    this.run = run;
    for (const member of [...this.members]) {
      for (const handler of [...member.handlers]) {
        if (run.abandoned) break;
        if (!member.handlers.has(handler)) continue;
        try {
          await handler(offer.pressure);
        } catch (err) {
          console.error(`opfs-lsm: an onPressure handler of "${this.name}" failed`, err);
        }
      }
    }
    this.run = undefined;
    if (run.abandoned) return;
    this.answered = offer.id;
    this.client()?.pressureDone(this.name, offer.id);
    if (this.handlers() === 0) {
      this.letGo();
      return;
    }
    const queued = this.queued;
    this.queued = undefined;
    if (queued) this.offer(queued);
  }

  /** No tab answers when the lock is free. Shared, so tabs that probe at once do not hide each other. */
  private probe(pressure: Pressure): void {
    const warn = () =>
      console.warn(
        `opfs-lsm: "${this.name}" holds about ${pressure.liveBytes} live bytes, over maxBytes ${pressure.maxBytes}, and no tab registered an onPressure handler`,
      );
    const locks = webLocks();
    if (!locks) {
      warn();
      return;
    }
    void locks
      .request(pressureLock(this.name), { mode: "shared", ifAvailable: true }, (lock) => {
        if (lock) warn();
      })
      .catch(() => undefined);
  }

  /** Ask for the lock. Once granted, pull the open offer: its broadcast may have come while another tab held it. */
  private ask(): void {
    const locks = webLocks();
    if (!locks) {
      this.lock = { kind: "holding", release: () => undefined };
      this.client()?.pullPressure(this.name);
      return;
    }
    const abort = new AbortController();
    let hold!: () => void;
    const held = new Promise<void>((resolve) => (hold = resolve));
    const lock: Lock = {
      kind: "asking",
      release: () => {
        abort.abort();
        hold();
      },
    };
    this.lock = lock;
    void locks
      .request(pressureLock(this.name), { signal: abort.signal }, () => {
        if (this.lock !== lock) return undefined;
        this.lock = { kind: "holding", release: hold };
        this.client()?.pullPressure(this.name);
        return held;
      })
      .catch(() => undefined);
  }

  private letGo(): void {
    if (this.lock.kind !== "free") this.lock.release();
    this.lock = FREE;
    this.queued = undefined;
  }

  register(member: PressureMember, handler: PressureHandler): () => void {
    member.handlers.add(handler);
    if (this.lock.kind === "free") this.ask();
    return () => {
      if (!member.handlers.delete(handler)) return;
      if (this.handlers() === 0 && !this.run) this.letGo();
    };
  }

  /**
   * A closed handle's handlers stop. When no handler is left the tab lets go
   * of the lock at once and abandons a run in progress: like a tab that went
   * away, it sends no answer, and the next holder pulls the offer.
   */
  leave(member: PressureMember): void {
    this.members.delete(member);
    member.handlers.clear();
    if (this.handlers() === 0) {
      if (this.run) this.run.abandoned = true;
      this.letGo();
    }
    if (this.members.size === 0) tabs.delete(this.key);
  }
}

/** One handle's part in its tab's pressure answers. */
export type PressureMember = {
  readonly tab: PressureTab;
  readonly ingest: IngestClient;
  readonly handlers: Set<PressureHandler>;
};

const tabs = new Map<string, PressureTab>();

/** `tab` names the browsing context; tests that model several tabs in one process pass their own. */
export function joinPressure(tab: string, name: string, ingest: IngestClient): PressureMember {
  const key = `${tab}\u0000${name}`;
  let shared = tabs.get(key);
  if (!shared) tabs.set(key, (shared = new PressureTab(key, name)));
  const member: PressureMember = { tab: shared, ingest, handlers: new Set() };
  shared.members.add(member);
  return member;
}
