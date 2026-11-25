/**
 * README "Errors", "Changes" and "Destroy": `close()` or `destroyDb` that
 * lands at any instant among calls in flight on one or two handles leaves
 * the handles and the stored rows in a state the contract allows:
 *
 * - every call settles, and a rejection is a `ClosedError` on a handle that
 *   `close()` or `destroyDb` closed;
 * - each `changes()` listener gets `closed` once, as its last event, with
 *   reason "close" or "destroyed";
 * - after `destroyDb` a reopen reads nothing;
 * - after `close` a reopen reads every acked write, and each write that
 *   failed with `ClosedError` wholly or not at all;
 * - a view reads each write wholly or not at all.
 *
 * Each write in flight touches keys no other write in flight touches, so the
 * rows they leave do not depend on their order.
 *
 * A wider sweep, and a replay of one seed:
 *   KV_CLOSE_SEEDS=1000 pnpm exec vitest run tests/sim/close-random.test.ts
 *   KV_CLOSE_FIRST=<seed> KV_CLOSE_SEEDS=1 pnpm exec vitest run tests/sim/close-random.test.ts
 */
import { describe, expect, it } from "vitest";
import { ClosedError, type ChangeEvent, type Db } from "../../src/index.js";
import { createLocalIngestClient, destroyHarnessDb, EngineHost, ingest, MemoryFs, openHarnessDb } from "../../src/testing.js";

const SEEDS = Number(process.env.KV_CLOSE_SEEDS ?? 40);
const FIRST = Number(process.env.KV_CLOSE_FIRST ?? (process.env.KV_CLOSE_SEEDS ? 1 + Math.floor(Math.random() * 2 ** 30) : 1));
const ROUNDS = 4;
const HANG_MS = 10_000;
const BASE = Array.from({ length: 8 }, (_, i) => `b${i}`);

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

/** What the runs met, so the test can say they met it. */
const tally = { closedWrites: 0, closedReads: 0 };

/** A write in flight: the value each key it touches holds after it, undefined for a delete. */
type Write = { readonly id: number; readonly effects: Map<string, string | undefined>; ending?: "acked" | "closed" };

type Handle = { readonly db: Db; readonly events: ChangeEvent[] };

/** Which writes `rows` hold: "all", "none", or "part" when only some of a write's keys show it. */
function seen(w: Write, rows: (key: string) => string | undefined, base: Rows): "all" | "none" | "part" {
  let mine = 0;
  let before = 0;
  for (const [key, value] of w.effects) {
    const got = rows(key);
    // A delete of a key that has no row reads the same either way.
    if (got === value) mine += 1;
    if (got === base.get(key)) before += 1;
  }
  if (mine === w.effects.size) return "all";
  if (before === w.effects.size) return "none";
  return "part";
}

async function rowsOf(read: { range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> }): Promise<Rows> {
  const rows: Rows = new Map();
  for await (const e of read.range()) rows.set(text(e.key), text(e.value));
  return rows;
}

async function run(seed: number): Promise<void> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const name = `close-random-${seed}`;
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const maxWalBytes = pick([256, 4096, 1 << 30]);
  const options = { name, fs, ingest: createLocalIngestClient(host), maxWalBytes };
  const open = async (): Promise<Handle> => {
    const db = await openHarnessDb(options);
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));
    return { db, events };
  };
  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const r = random();
      await (r < 0.4 ? Promise.resolve() : new Promise((resolve) => (r < 0.8 ? setImmediate(resolve) : setTimeout(resolve, 0))));
    }
  };
  let base: Rows = new Map();
  let id = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const label = `seed ${seed}, round ${round}`;
    const handles = random() < 0.5 ? [await open()] : [await open(), await open()];
    for (let i = Math.floor(random() * 4); i > 0; i--) {
      const key = pick(BASE);
      const value = `r${round}.${++id}`;
      await handles[0]!.db.put(utf(key), utf(value));
      base.set(key, value);
    }
    if (random() < 0.3) await ingest(handles[0]!.db);
    for (const { db } of handles) await db.sync();

    const closed = new Set<Db>();
    const problems: string[] = [];
    const writes: Write[] = [];
    const free = BASE.filter(() => random() < 0.8);
    const claim = () => free.splice(Math.floor(random() * free.length), 1)[0];
    const reads: (() => void)[] = [];

    const track = <T>(db: Db, what: string, call: Promise<T>, acked: (value: T) => void, lost: () => void = () => undefined) =>
      call.then(acked, (err: unknown) => {
        if (err instanceof ClosedError && closed.has(db)) {
          if (/^(get|range|view|sync)/.test(what)) tally.closedReads += 1;
          return lost();
        }
        problems.push(`${what} rejected with ${String(err)}${err instanceof ClosedError ? " on a handle that is not closed" : ""}`);
      });

    const call = (db: Db): Promise<void> => {
      const n = ++id;
      const roll = random();
      if (roll < 0.55) {
        const w: Write = { id: n, effects: new Map() };
        writes.push(w);
        const end = [() => void (w.ending = "acked"), () => {
          w.ending = "closed";
          tally.closedWrites += 1;
        }] as const;
        if (roll < 0.2) {
          const key = (random() < 0.5 && claim()) || `r${round}/p${n}`;
          w.effects.set(key, `v${n}`);
          return track(db, `put ${n}`, db.put(utf(key), utf(`v${n}`)), ...end);
        }
        if (roll < 0.4) {
          for (let i = 1 + Math.floor(random() * 3); i > 0; i--) w.effects.set(`r${round}/x${n}.${i}`, `v${n}`);
          const old = random() < 0.6 && claim();
          if (old) w.effects.set(old, random() < 0.5 ? `v${n}` : undefined);
          return track(
            db,
            `batch ${n}`,
            db.batch((tx) => {
              for (const [key, value] of w.effects) {
                if (value === undefined) tx.delete(utf(key));
                else tx.put(utf(key), utf(value));
              }
            }),
            ...end,
          );
        }
        const old = claim();
        const fresh = `r${round}/u${n}`;
        w.effects.set(fresh, `v${n}`);
        if (old) w.effects.set(old, `${base.get(old) ?? ""}|${n}`);
        const keys = old ? [utf(old)] : [];
        return track(
          db,
          `update ${n}`,
          db.update(keys, ([cur], tx) => {
            if (old) tx.put(utf(old), utf(`${cur ? text(cur) : ""}|${n}`));
            tx.put(utf(fresh), utf(`v${n}`));
          }),
          ...end,
        );
      }
      if (roll < 0.67) {
        const key = pick(BASE);
        return track(db, `get ${n}`, db.get(utf(key)), (value) => {
          reads.push(() => {
            const got = value && text(value);
            const by = writes.find((w) => w.effects.has(key));
            if (got !== base.get(key) && !(by && got === by.effects.get(key))) problems.push(`get(${key}) = ${got}, neither ${base.get(key)} nor a write's`);
          });
        });
      }
      if (roll < 0.77) return track(db, `range ${n}`, rowsOf(db), () => undefined);
      if (roll < 0.9) {
        return track(db, `view ${n}`, db.view((snap) => rowsOf(snap)), (rows) => {
          reads.push(() => {
            for (const w of writes) {
              if (seen(w, (key) => rows.get(key), base) === "part") problems.push(`a view reads part of write ${w.id}`);
            }
          });
        });
      }
      return track(db, `sync ${n}`, db.sync(), () => undefined);
    };

    const calls: Promise<void>[] = [];
    for (let i = 2 + Math.floor(random() * 7); i > 0; i--) calls.push(call(pick(handles).db));
    await turns(Math.floor(random() * 10));
    const end = pick(["close one", "close all", "destroyDb"] as const);
    const ending = end === "close one" ? [handles[0]!] : handles;
    for (const { db } of ending) closed.add(db);
    if (end === "destroyDb") calls.push(track(handles[0]!.db, "destroyDb", destroyHarnessDb(options), () => undefined));
    else for (const { db } of ending) calls.push(track(db, "close", db.close(), () => undefined));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<string>((resolve) => (timer = setTimeout(resolve, HANG_MS, "hung")));
    const outcome = await Promise.race([Promise.all(calls).then(() => "settled"), hung]);
    clearTimeout(timer);
    expect(outcome, `${label}: every call settles (${end})`).toBe("settled");
    for (const { db } of handles) await db.close();
    await turns(4);
    for (const check of reads) check();
    expect(problems, `${label}: calls (${end})`).toEqual([]);

    for (const [i, { db, events }] of handles.entries()) {
      const reason = end === "destroyDb" ? "destroyed" : "close";
      expect(events.filter((e) => e.kind === "closed"), `${label}: handle ${i} hears closed once (${end})`).toEqual([{ kind: "closed", reason }]);
      expect(events.at(-1), `${label}: closed is the last event of handle ${i}`).toEqual({ kind: "closed", reason });
      expect(closed.has(db) || end !== "destroyDb", `${label}: destroyDb closes every handle`).toBe(true);
    }

    const again = await open();
    const rows = await rowsOf(again.db);
    await again.db.close();
    if (end === "destroyDb") {
      expect([...rows.keys()], `${label}: a reopen after destroyDb reads nothing`).toEqual([]);
      base = new Map();
      continue;
    }
    for (const w of writes) {
      const got = seen(w, (key) => rows.get(key), base);
      const want = w.ending === "acked" ? ["all"] : ["all", "none"];
      expect(want, `${label}: a reopen after ${end} reads ${got} of write ${w.id}, which ended ${w.ending}`).toContain(got);
    }
    const touched = new Set(writes.flatMap((w) => [...w.effects.keys()]));
    for (const key of new Set([...rows.keys(), ...base.keys()])) {
      if (!touched.has(key)) expect(rows.get(key), `${label}: ${key}, which no write in flight touched`).toBe(base.get(key));
    }
    base = rows;
  }
  await destroyHarnessDb(options);
}

describe("close() or destroyDb among calls in flight", () => {
  it("settles every call, ends each feed with one closed event, and keeps exactly the writes the contract allows", async () => {
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) await run(seed);
    expect(tally.closedWrites, "the runs met writes that failed with ClosedError").toBeGreaterThan(0);
    expect(tally.closedReads, "the runs met reads that failed with ClosedError").toBeGreaterThan(0);
  }, 900_000);
});
