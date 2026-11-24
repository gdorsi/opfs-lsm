/**
 * README "Changes", design.md "Change events": a
 * listener of `changes()` hears every WAL record its handle applies once, in
 * seq order, or one `gap` that covers it, and `snap.seq` is the seq of the
 * last record a view includes. Together they let an app keep an exact copy of
 * the database: apply each `append`, and at a `gap` read a view again and
 * drop the appends at or below its `snap.seq`.
 *
 * The copy of each handle is checked against what the handle reads, under
 * random puts, deletes, batches, range deletes, updates, flushes, syncs,
 * `dangerousDestroy` and reopen, from three handles, one of them without
 * BroadcastChannel.
 *
 * The copy also checks `update` (README "Read-modify-write"): each update
 * writes the value it read plus a tag, so its record must extend the value
 * the copy holds just before that record, in every handle's feed.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db } from "../../src/index.js";
import { EngineHost, createLocalIngestClient, ingest, MemoryFs, openHarnessDb } from "../../src/testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => dec.decode(b);
const KEYS = Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, "0")}`);

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

/** What an update keeps of the value it read. */
const tail = (value: string | undefined) => (value ?? "").slice(-10);

async function rowsOf(db: Db): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const e of db.range()) out.push([text(e.key), text(e.value)]);
  return out;
}

/** The copy an app keeps from `changes()` alone, plus a view at each gap. */
class Mirror {
  rows = new Map<string, string>();
  /** The copy holds every record through this seq. */
  seq = 0;
  readonly problems: string[] = [];
  private lastEvent = 0;
  private reload: Promise<void> | undefined;
  private waiting: Extract<ChangeEvent, { kind: "append" }>[] = [];
  private round = 0;
  private stop: () => void;

  constructor(private readonly db: Db) {
    this.stop = db.changes((e) => this.hear(e));
    this.read();
  }

  private hear(e: ChangeEvent): void {
    if (e.kind === "closed") return;
    const at = e.kind === "append" ? e.seq : e.through;
    if (at <= this.lastEvent) this.problems.push(`${e.kind} ${at} after ${this.lastEvent}`);
    this.lastEvent = at;
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
    const loaded = this.db
      .view(async (snap) => {
        const rows = new Map<string, string>();
        for await (const e of snap.range()) rows.set(text(e.key), text(e.value));
        return { seq: snap.seq, rows };
      })
      .then(
        ({ seq, rows }) => {
          if (round !== this.round) return;
          this.rows = rows;
          this.seq = seq;
          this.reload = undefined;
          for (const e of this.waiting.splice(0)) this.apply(e);
        },
        () => undefined,
      );
    this.reload = loaded;
  }

  private apply(e: Extract<ChangeEvent, { kind: "append" }>): void {
    if (e.seq <= this.seq) return;
    for (const op of e.ops) {
      if (op.type === "put") {
        const key = text(op.key);
        const value = text(op.value);
        const read = /^(.*)\|u\d+$/.exec(value)?.[1];
        const held = tail(this.rows.get(key));
        if (read !== undefined && read !== held) this.problems.push(`update at ${e.seq} read ${read}, the value before it was ${held}`);
        this.rows.set(key, value);
      }
      else if (op.type === "del") this.rows.delete(text(op.key));
      else {
        // The test asks for no `through`, so the op removes every row written before it.
        if (op.through !== e.seq - 1) this.problems.push(`deleteRange at ${e.seq} through ${op.through}`);
        const start = text(op.start);
        const end = op.endExclusive && text(op.endExclusive);
        for (const key of [...this.rows.keys()]) if (key >= start && (end === undefined || key < end)) this.rows.delete(key);
      }
    }
    this.seq = e.seq;
  }

  async settled(): Promise<[string, string][]> {
    while (this.reload) await this.reload;
    return [...this.rows].sort(([a], [b]) => (a < b ? -1 : 1));
  }

  close(): void {
    this.stop();
  }
}

/** Gaps every copy met, so the test can say its runs had some. */
let gaps = 0;

type Slot = { db: Db; mirror: Mirror; readonly bus: boolean };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function run(seed: number, steps: number): Promise<void> {
  const name = `change-feed-${seed}`;
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const key = () => utf(pick(KEYS));

  const openSlot = async (bus: boolean): Promise<Slot> => {
    const g = globalThis as { BroadcastChannel?: unknown };
    const real = g.BroadcastChannel;
    if (!bus) g.BroadcastChannel = undefined;
    try {
      const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
      return { db, mirror: new Mirror(db), bus };
    } finally {
      g.BroadcastChannel = real;
    }
  };
  const slots = [await openSlot(true), await openSlot(true), await openSlot(false)];
  cleanup = async () => {
    for (const slot of slots) await slot.db.close();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  };

  let n = 0;
  const op = (slot: Slot): Promise<unknown> => {
    const { db } = slot;
    const roll = random();
    const value = utf(`v${++n}`);
    if (roll < 0.3) return db.put(key(), value);
    if (roll < 0.4) return db.delete(key());
    if (roll < 0.5) {
      const a = key();
      const b = key();
      const c = key();
      return db.batch((tx) => {
        tx.put(a, value);
        tx.delete(b);
        tx.put(c, value);
      });
    }
    if (roll < 0.58) {
      const [lo, hi] = [pick(KEYS), pick(KEYS)].sort() as [string, string];
      const also = key();
      return db.batch((tx) => {
        if (lo < hi) tx.deleteRange({ start: utf(lo), endExclusive: utf(hi) });
        else tx.deleteRange({ start: utf(lo) });
        tx.put(also, value);
      });
    }
    if (roll < 0.74) {
      const k = key();
      const tag = `|u${n}`;
      return db.update([k], ([cur], tx) => {
        tx.put(k, utf(`${tail(cur && text(cur))}${tag}`));
      });
    }
    if (roll < 0.8) return db.update([key()], () => undefined);
    if (roll < 0.9) return db.sync();
    if (roll < 0.95) return ingest(db);
    if (roll < 0.975) return db.dangerousDestroy();
    return (async () => {
      slot.mirror.close();
      await db.close();
      const again = await openSlot(slot.bus);
      slot.db = again.db;
      slot.mirror = again.mirror;
    })();
  };

  for (let step = 0; step < steps; step++) {
    // One op on each of up to three handles at once, then sometimes a pause for the channel.
    const together = 1 + Math.floor(random() * 3);
    const busy = [...slots].sort(() => random() - 0.5).slice(0, together);
    const results = await Promise.allSettled(busy.map((slot) => op(slot)));
    for (const r of results) if (r.status === "rejected") throw r.reason;
    if (random() < 0.3) await new Promise((r) => setTimeout(r, 0));
  }

  for (const slot of slots) await slot.db.sync();
  const want = await rowsOf(slots[0]!.db);
  for (const [i, slot] of slots.entries()) {
    expect(await rowsOf(slot.db), `seed ${seed}: handle ${i} reads what handle 0 reads`).toEqual(want);
    expect(await slot.mirror.settled(), `seed ${seed}: the copy of handle ${i}`).toEqual(want);
    expect(slot.mirror.problems, `seed ${seed}: events of handle ${i}`).toEqual([]);
    expect(slot.mirror.seq, `seed ${seed}: the copy of handle ${i} is at the handle's seq`).toBe(await slot.db.view((snap) => snap.seq));
  }
}

describe("a copy kept from changes() and a view at each gap", () => {
  it("equals what its handle reads, and every update extends the value before it, under random writes, flushes and destroys from three handles", async () => {
    const seeds = Number(process.env.KV_FEED_SEEDS ?? 40);
    for (let seed = 1; seed <= seeds; seed++) {
      await run(seed, Number(process.env.KV_FEED_STEPS ?? 60));
      await cleanup?.();
      cleanup = undefined;
    }
    expect(gaps, "the runs met gaps").toBeGreaterThan(0);
  }, 900_000);
});
