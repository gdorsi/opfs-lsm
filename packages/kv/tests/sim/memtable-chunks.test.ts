import { afterEach, expect, it } from "vitest";
import { compareBytes } from "../../src/bytes.js";
import type { Db, Range } from "../../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../../src/testing.js";
import { compactHost } from "../compact-host.js";

/**
 * A seeded differential of the public read API against an array model, with
 * a memtable of several chunks: thousands of keys, batches that cross the
 * chunk split, range deletes that cover whole chunks or cut the first and
 * the last, bounds on and next to the first key of a chunk, scans paused
 * while writes, range deletes and flushes land, views, and a second handle
 * that follows by sync.
 * A wider sweep: KV_CHUNKS_SEEDS=200 KV_CHUNKS_STEPS=120.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const N = 5200;
const KEYS = Array.from({ length: N }, (_, i) => enc.encode(`k${String(i).padStart(5, "0")}`));

/** The first key index at or after `bound`. */
function lower(bound: Uint8Array): number {
  let lo = 0;
  let hi = N;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareBytes(KEYS[mid]!, bound) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type State = { vals: (string | undefined)[]; seqs: number[] };

function modelRange(state: State, range: Range): string[] {
  const lo = range.start ? lower(range.start) : 0;
  const hi = range.endExclusive ? lower(range.endExclusive) : N;
  const patterns = (range.valueContains ?? []).map((p) => dec.decode(p));
  const out: string[] = [];
  for (let i = lo; i < hi; i++) {
    const v = state.vals[i];
    if (v !== undefined && patterns.every((p) => v.includes(p))) out.push(`${dec.decode(KEYS[i]!)}=${v}`);
  }
  if (range.reverse) out.reverse();
  const from = range.offset ?? 0;
  return out.slice(from, range.limit === undefined ? undefined : from + range.limit);
}

const row = (e: { key: Uint8Array; value: Uint8Array }) => `${dec.decode(e.key)}=${dec.decode(e.value)}`;
const showRange = (r: Range) =>
  JSON.stringify({ ...r, start: r.start && dec.decode(r.start), endExclusive: r.endExclusive && dec.decode(r.endExclusive), valueContains: r.valueContains?.map((p) => dec.decode(p)) });

function same(got: readonly (string | undefined)[], want: readonly (string | undefined)[], label: () => string): void {
  if (got.length === want.length && got.every((g, i) => g === want[i])) return;
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  throw new Error(
    `${label()}\n  got ${got.length} entries, want ${want.length}; first difference at ${i}:\n  got  ${got.slice(Math.max(0, i - 1), i + 3).join(" | ")}\n  want ${want.slice(Math.max(0, i - 1), i + 3).join(" | ")}`,
  );
}

const opened: Db[] = [];
let n = 0;

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

async function run(seed: number): Promise<void> {
  let state = seed * 7919 + 1;
  const rnd = (k: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % k;
  const fs = new MemoryFs();
  // Every fourth seed writes values that outgrow a 1 MiB cache, so scans wait on pages while the memtable changes.
  const cold = seed % 4 === 1;
  const pad = cold ? "p".repeat(400) : "";
  const host = new EngineHost(() => fs, { flushRunBytes: (cold ? 256 : 16) * 1024, l0StopRuns: Number.POSITIVE_INFINITY, maxSources: 3 });
  const name = `memtable-chunks-${process.pid}-${++n}`;
  // Every third seed lets the host flush on its own, racing the commands.
  const maxWalBytes = seed % 3 === 0 ? (cold ? 1024 : 96) * 1024 : 1 << 30;
  const options = { name, fs, ingest: createLocalIngestClient(host), maxWalBytes, rowPostMs: 0, ...(cold ? { cacheBytes: 1 << 20 } : {}) };
  const d = await openHarnessDb({ ...options, writerId: "w1" });
  opened.push(d);
  const follower = await openHarnessDb({ ...options, ingest: createLocalIngestClient(host), writerId: "w2" });
  opened.push(follower);
  const firstsOf = () => (d as unknown as { mem: { firsts: Uint8Array[] } }).mem.firsts;

  const model: State = { vals: new Array<string | undefined>(N).fill(undefined), seqs: new Array<number>(N).fill(0) };
  const snapshot = (): State => ({ vals: model.vals.slice(), seqs: model.seqs.slice() });
  let head = 0;
  let v = 0;
  const log: string[] = [];
  const tail = () => `seed ${seed}: ${log.slice(-14).join(", ")}`;

  /** A bound on, just past, just before or far from the first key of a chunk. */
  const bound = (): Uint8Array => {
    const firsts = firstsOf();
    const pick = rnd(8);
    if (pick < 3 && firsts.length > 1) {
      const first = firsts[1 + rnd(firsts.length - 1)]!;
      const what = rnd(4);
      if (what === 0) return first;
      if (what === 1) return Uint8Array.of(...first, 0);
      const i = lower(first);
      if (what === 2) return KEYS[Math.max(0, i - 1)]!;
      return KEYS[Math.min(N - 1, i + 1)]!;
    }
    const k = KEYS[rnd(N)]!;
    if (pick === 3) return Uint8Array.of(...k, 0);
    if (pick === 4) return k.subarray(0, 1 + rnd(k.length));
    return k;
  };

  const randomRange = (): Range => {
    const a = bound();
    const b = bound();
    const [start, end] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
    const span = rnd(5);
    return {
      ...(span !== 0 ? { start } : {}),
      ...(span !== 1 && compareBytes(start, end) < 0 ? { endExclusive: end } : {}),
      ...(rnd(2) ? { reverse: true } : {}),
      ...(rnd(3) === 0 ? { limit: [0, 1, 7, 511, 512, 513, 1500][rnd(7)]! } : {}),
      ...(rnd(4) === 0 ? { offset: [1, 3, 511, 512, 513, 1100][rnd(6)]! } : {}),
      ...(rnd(5) === 0 ? { valueContains: [enc.encode(["1.", "v2", "99", "."][rnd(4)]!)] } : {}),
    };
  };

  const write = async () => {
    const ops: ((tx: Parameters<Parameters<Db["batch"]>[0]>[0]) => void)[] = [];
    const seq = head + 1;
    const shape = rnd(6);
    const count = shape === 0 ? 600 + rnd(1200) : shape === 1 ? 200 + rnd(300) : 1 + rnd(6);
    const sequentialFrom = rnd(3) === 0 ? rnd(N) : -1;
    let rangeDeletes = 0;
    for (let i = 0; i < count; i++) {
      if (rnd(shape < 2 ? 400 : 6) === 0) {
        const a = bound();
        const b = bound();
        const [start, end] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
        const open = rnd(6) === 0 || compareBytes(start, end) === 0;
        const whole = rnd(8) === 0;
        const t = rnd(10);
        const through = t < 6 ? undefined : t < 9 ? Math.max(0, head - rnd(5)) : t === 9 && rnd(2) ? 0 : head + 5;
        const s = whole ? new Uint8Array(0) : start;
        ops.push((tx) => tx.deleteRange(open ? { start: s } : { start: s, endExclusive: end }, through === undefined ? {} : { through }));
        const resolved = Math.min(through ?? Number.MAX_SAFE_INTEGER, seq - 1);
        for (let k = lower(s), hi = open ? N : lower(end); k < hi; k++) {
          if (model.seqs[k]! > 0 && model.seqs[k]! <= resolved) {
            model.vals[k] = undefined;
            model.seqs[k] = 0;
          }
        }
        rangeDeletes++;
        continue;
      }
      const k = sequentialFrom >= 0 ? (sequentialFrom + i) % N : rnd(N);
      if (rnd(12) === 0) {
        ops.push((tx) => tx.delete(KEYS[k]!));
        model.vals[k] = undefined;
      } else {
        const value = `${rnd(1000)}.v${++v}.${pad}`;
        ops.push((tx) => tx.put(KEYS[k]!, enc.encode(value)));
        model.vals[k] = value;
      }
      model.seqs[k] = seq;
    }
    const acked = await d.batch((tx) => ops.forEach((op) => op(tx)));
    head = seq;
    if (acked !== seq) throw new Error(`${tail()}: batch acked ${acked}, want ${seq}`);
    log.push(`batch#${seq}(${count}${rangeDeletes ? `,${rangeDeletes}dr` : ""})`);
  };

  const move = async () => {
    const what = rnd(5);
    if (what === 0) {
      await ingest(d);
      log.push("ingest");
    } else if (what === 1) {
      await host.ingest(name);
      log.push("flush");
    } else if (what === 2) {
      await compactHost(host, name);
      log.push("compact");
    } else if (what === 3) {
      await d.sync();
      log.push("sync");
    }
  };

  const writeOrMove = async () => {
    for (let i = 0, times = 1 + rnd(3); i < times; i++) {
      if (rnd(3)) await write();
      else await move();
    }
  };

  const collect = async (source: AsyncIterable<{ key: Uint8Array; value: Uint8Array }>) => {
    const out: string[] = [];
    for await (const e of source) out.push(row(e));
    return out;
  };

  const checkReads = async (db: Db, who: string) => {
    const probes = [bound(), bound(), KEYS[rnd(N)]!, KEYS[rnd(N)]!].filter((k) => k.length > 0);
    const want = probes.map((k) => {
      const i = lower(k);
      return i < N && compareBytes(KEYS[i]!, k) === 0 ? model.vals[i] : undefined;
    });
    same((await db.getMany(probes)).map((x) => x && dec.decode(x)), want, () => `${tail()}: ${who} getMany`);
    for (let r = 0; r < 4; r++) {
      const range = randomRange();
      const wanted = modelRange(model, range);
      same(await collect(db.range(range)), wanted, () => `${tail()}: ${who} range ${showRange(range)}`);
      const count = await db.count(range);
      if (count !== wanted.length) throw new Error(`${tail()}: ${who} count ${showRange(range)}: got ${count}, want ${wanted.length}`);
    }
    if (rnd(4) === 0) {
      same(await collect(db.range()), modelRange(model, {}), () => `${tail()}: ${who} full scan`);
      same(await collect(db.range({ reverse: true })), modelRange(model, { reverse: true }), () => `${tail()}: ${who} full reverse scan`);
    }
  };

  /** Scans started now, read a few entries at a time while writes and flushes land between the reads. */
  const pausedScans = async () => {
    const scans = Array.from({ length: 1 + rnd(3) }, () => {
      const range = rnd(3) === 0 ? { ...(rnd(2) ? { reverse: true } : {}) } : randomRange();
      return { range, it: d.range(range)[Symbol.asyncIterator](), got: [] as string[], at: undefined as State | undefined, p: 0, done: false };
    });
    for (let round = 0; round < 4; round++) {
      for (const scan of scans) {
        if (scan.done) continue;
        // The scan reads the state at its first `next()`.
        if (!scan.at) {
          scan.at = snapshot();
          scan.p = head;
        }
        const take = round === 3 ? Number.POSITIVE_INFINITY : [0, 1, 5, 300, 512, 700, 1400][rnd(7)]!;
        for (let i = 0; i <= take; i++) {
          const r = await scan.it.next();
          if (r.done) {
            scan.done = true;
            break;
          }
          scan.got.push(row(r.value));
        }
      }
      if (round < 3) await writeOrMove();
    }
    for (const scan of scans) same(scan.got, modelRange(scan.at!, scan.range), () => `${tail()}: paused scan started at ${scan.p} ${showRange(scan.range)}`);
    log.push("paused-scans");
  };

  const viewAcrossWrites = async () => {
    await d.view(async (snap) => {
      const at = snapshot();
      const p = head;
      if (snap.seq !== p) throw new Error(`${tail()}: snap.seq ${snap.seq}, want ${p}`);
      const early = randomRange();
      const earlyIt = snap.range(early)[Symbol.asyncIterator]();
      const earlyGot: string[] = [];
      for (let i = 0, take = rnd(600); i < take; i++) {
        const r = await earlyIt.next();
        if (r.done) break;
        earlyGot.push(row(r.value));
      }
      await writeOrMove();
      for (let r = await earlyIt.next(); !r.done; r = await earlyIt.next()) earlyGot.push(row(r.value));
      same(earlyGot, modelRange(at, early), () => `${tail()}: view at ${p} scan paused across writes ${showRange(early)}`);
      for (let r = 0; r < 3; r++) {
        const range = randomRange();
        const wanted = modelRange(at, range);
        same(await collect(snap.range(range)), wanted, () => `${tail()}: view at ${p} range ${showRange(range)}`);
        const count = await snap.count(range);
        if (count !== wanted.length) throw new Error(`${tail()}: view at ${p} count ${showRange(range)}: got ${count}, want ${wanted.length}`);
        const values = await snap.rangeValues(range, (bytes) => dec.decode(bytes));
        same(values.map((e) => `${dec.decode(e.key)}=${e.value}`), wanted, () => `${tail()}: view at ${p} rangeValues ${showRange(range)}`);
      }
      const probes = [bound(), bound(), KEYS[rnd(N)]!].filter((k) => k.length > 0);
      const want = probes.map((k) => {
        const i = lower(k);
        return i < N && compareBytes(KEYS[i]!, k) === 0 ? at.vals[i] : undefined;
      });
      same((await snap.getMany(probes)).map((x) => x && dec.decode(x)), want, () => `${tail()}: view at ${p} getMany`);
    });
    log.push("view");
  };

  const steps = Number(process.env.KV_CHUNKS_STEPS ?? 45);
  for (let step = 0; step < steps; step++) {
    const what = rnd(12);
    if (what < 6) await write();
    else if (what < 8) await move();
    else if (what < 10) await pausedScans();
    else await viewAcrossWrites();
    await checkReads(d, "writer");
    if (rnd(5) === 0) {
      await follower.sync();
      log.push("follower-sync");
      await checkReads(follower, "follower");
    }
  }
}

const first = Number(process.env.KV_CHUNKS_FIRST ?? 1);
for (const seed of Array.from({ length: Number(process.env.KV_CHUNKS_SEEDS ?? 6) }, (_, i) => first + i)) {
  it(`reads over a memtable of several chunks agree with an array model, across range deletes, paused scans, views and flushes (seed ${seed})`, async () => {
    await expect(run(seed)).resolves.toBeUndefined();
  }, 240_000);
}
