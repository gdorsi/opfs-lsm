/**
 * README "Changes": a copy of the database kept from `changes()` alone,
 * each `append` applied in order and the whole copy read again in a view at
 * each `gap`, equals what a view of the handle reads at the same seq. It
 * holds with several calls in flight on the handle at once, a second handle
 * writing, background flushes from a small `maxWalBytes`, writes that wait
 * at the memtable limit, and `dangerousDestroy` from either handle. The
 * copy is compared at every point where no call is in flight, and the
 * listener hears each put, delete and batch of its handle before it resolves.
 *
 * A wider sweep, and a replay of one seed:
 *   KV_INFLIGHT_SEEDS=400 pnpm exec vitest run tests/sim/in-flight-feed.test.ts
 *   KV_INFLIGHT_FIRST=<seed> KV_INFLIGHT_SEEDS=1 pnpm exec vitest run tests/sim/in-flight-feed.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ChangeEvent, Db } from "../../src/index.js";
import { createLocalIngestClient, destroyHarnessDb, EngineHost, ingest, MemoryFs, openHarnessDb } from "../../src/testing.js";

const SEEDS = Number(process.env.KV_INFLIGHT_SEEDS ?? 16);
const FIRST = Number(process.env.KV_INFLIGHT_FIRST ?? (process.env.KV_INFLIGHT_SEEDS ? 1 + Math.floor(Math.random() * 2 ** 30) : 1));
const STEPS = 30;
const HANG_MS = 10_000;
const MiB = 1024 * 1024;
const KEYS = Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, "0")}`);

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => dec.decode(b);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rows = Map<string, string>;

async function rowsOf(read: { range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> }): Promise<Rows> {
  const rows: Rows = new Map();
  for await (const e of read.range()) rows.set(text(e.key), text(e.value));
  return rows;
}

const sorted = (rows: Rows) => [...rows].sort(([a], [b]) => (a < b ? -1 : 1));

/** What gaps the runs met, so the test can say they met some. */
let gaps = 0;

/** The copy an app keeps from `changes()` alone, plus a view at each gap. */
class Mirror {
  rows: Rows = new Map();
  /** The copy holds every record through this seq. */
  seq = 0;
  /** The highest seq an event named. */
  heard = 0;
  readonly problems: string[] = [];
  private reload: Promise<void> | undefined;
  private waiting: Extract<ChangeEvent, { kind: "append" }>[] = [];
  private round = 0;

  constructor(private readonly db: Db) {
    db.changes((e) => this.hear(e));
    this.read();
  }

  get reloading(): boolean {
    return this.reload !== undefined;
  }

  private hear(e: ChangeEvent): void {
    if (e.kind === "closed") return;
    const at = e.kind === "append" ? e.seq : e.through;
    if (at <= this.heard) this.problems.push(`${e.kind} ${at} after ${this.heard}`);
    this.heard = at;
    if (e.kind === "gap") {
      gaps += 1;
      return this.read();
    }
    if (this.reload) this.waiting.push(e);
    else this.apply(e);
  }

  /** Read the whole database in a view taken now, and go on from its seq. */
  private read(): void {
    const round = ++this.round;
    this.waiting = [];
    this.reload = this.db
      .view(async (snap) => ({ seq: snap.seq, rows: await rowsOf(snap) }))
      .then(
        ({ seq, rows }) => {
          if (round !== this.round) return;
          this.rows = rows;
          this.seq = seq;
          this.reload = undefined;
          for (const e of this.waiting.splice(0)) this.apply(e);
        },
        (err: unknown) => void this.problems.push(`the view at a gap rejected with ${String(err)}`),
      );
  }

  private apply(e: Extract<ChangeEvent, { kind: "append" }>): void {
    if (e.seq <= this.seq) return;
    for (const op of e.ops) {
      if (op.type === "put") this.rows.set(text(op.key), text(op.value));
      else if (op.type === "del") this.rows.delete(text(op.key));
      else {
        // No write here names a `through`, so a range delete removes every row before it.
        const start = text(op.start);
        const end = op.endExclusive && text(op.endExclusive);
        for (const key of [...this.rows.keys()]) if (key >= start && (end === undefined || key < end)) this.rows.delete(key);
      }
    }
    this.seq = e.seq;
  }

  async settled(): Promise<void> {
    while (this.reload) await this.reload;
  }
}

async function run(seed: number): Promise<void> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const name = `in-flight-feed-${seed}`;
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const options = { name, fs, ingest: createLocalIngestClient(host), maxWalBytes: pick([256, 4096, 1 << 30]), memtableBytes: MiB };
  const a = await openHarnessDb(options);
  const b = await openHarnessDb(options);
  const mirror = new Mirror(a);
  const problems: string[] = [];
  let n = 0;

  const key = () => utf(pick(KEYS));
  const value = (i: number) => utf(`v${i}`);
  const ownSeq = (what: string) => (seq: number) => {
    if (mirror.heard < seq) problems.push(`${what} resolved at seq ${seq} before its listener heard it (heard ${mirror.heard})`);
  };

  const write = (db: Db, roll: number): Promise<unknown> => {
    const i = ++n;
    const mine = db === a ? ownSeq : () => () => undefined;
    if (roll < 0.35) return db.put(key(), value(i)).then(mine(`put ${i}`));
    if (roll < 0.45) return db.delete(key()).then(mine(`delete ${i}`));
    if (roll < 0.6) {
      const [k1, k2, k3, v] = [key(), key(), key(), value(i)];
      return db
        .batch((tx) => {
          tx.put(k1, v);
          tx.delete(k2);
          tx.put(k3, v);
        })
        .then(mine(`batch ${i}`));
    }
    if (roll < 0.67) {
      const [lo, hi] = [pick(KEYS), pick(KEYS)].sort() as [string, string];
      const [also, v] = [key(), value(i)];
      return db
        .batch((tx) => {
          tx.deleteRange(lo < hi ? { start: utf(lo), endExclusive: utf(hi) } : { start: utf(lo) });
          tx.put(also, v);
        })
        .then(mine(`range delete ${i}`));
    }
    if (roll < 0.96) {
      const k = key();
      return db.update([k], ([cur], tx) => tx.put(k, utf(`${cur ? text(cur).slice(0, 12) : ""}|u${i}`)));
    }
    return db.dangerousDestroy();
  };

  const call = (): Promise<unknown> => {
    const roll = random();
    if (roll < 0.55) return write(a, random());
    if (roll < 0.62) {
      // Writes one after another fill the memtable past its limit before a flush empties it.
      const big = Array.from({ length: 3 }, () => [key(), utf(`v${++n}${".".repeat(400 * 1024)}`)] as const);
      return (async () => {
        for (const [k, v] of big) ownSeq("a large put")(await a.put(k, v));
      })();
    }
    if (roll < 0.7) return a.get(key());
    if (roll < 0.8) return a.view((snap) => rowsOf(snap));
    if (roll < 0.9) return a.sync();
    if (roll < 0.95) return rowsOf(a);
    return ingest(a);
  };

  for (let step = 0; step < STEPS; step++) {
    const label = `seed ${seed}, step ${step}`;
    const calls: Promise<unknown>[] = [];
    for (let i = 2 + Math.floor(random() * 5); i > 0; i--) calls.push(call());
    for (let i = Math.floor(random() * 4); i > 0; i--) calls.push(write(b, random()));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<string>((resolve) => (timer = setTimeout(resolve, HANG_MS, "hung")));
    const outcome = await Promise.race([Promise.all(calls).then(() => "settled", (err: unknown) => `rejected with ${String(err)}`), hung]);
    clearTimeout(timer);
    expect(outcome, `${label}: every call resolves`).toBe("settled");

    await a.sync();
    for (let tries = 0; ; tries++) {
      expect(tries, `${label}: the copy reaches the seq of a view`).toBeLessThan(20);
      await mirror.settled();
      const seen = await a.view(async (snap) => {
        if (mirror.reloading || mirror.seq !== snap.seq) return undefined;
        const copy = sorted(mirror.rows);
        return { copy, rows: sorted(await rowsOf(snap)), seq: snap.seq };
      });
      if (!seen) continue;
      expect(seen.copy, `${label}: the copy at seq ${seen.seq} equals a view at that seq`).toEqual(seen.rows);
      break;
    }
    expect([...problems, ...mirror.problems], `${label}: events`).toEqual([]);
  }

  await a.close();
  await b.close();
  await destroyHarnessDb(options);
}

describe("a copy kept from changes() with several calls in flight", () => {
  it("equals a view at the same seq at every quiet point, under a second writer, flushes, the memtable limit and destroys", async () => {
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) await run(seed);
    expect(gaps, "the runs met gaps").toBeGreaterThan(0);
  }, 900_000);
});
