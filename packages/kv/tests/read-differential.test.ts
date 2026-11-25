import { afterEach, assert, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { prefixBound, type Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { applyOps, Oracle, show, type OracleOp, type OracleRange } from "./sim/oracle.js";
import { compactHost } from "./compact-host.js";

/**
 * A randomized differential test of reads against the sim oracle, aimed
 * where the sim's fixed 16-key set does not reach: hundreds of keys with
 * shared prefixes, keys up to the 8 KiB limit, runs of FF and 00 bytes,
 * values that fill several blocks and evict pages from a 1 MiB cache,
 * range bounds that land between and on keys in the middle of blocks, and
 * a host with small flush runs and few merge sources, so L0 runs and L1
 * runs coexist. Views and range iterators stay open across writes,
 * flushes and compactions, and every read API answers: get, getMany with
 * repeated keys and with decode, range, count, rangeValues and rangeJoin.
 * A key is sometimes passed as a view into a larger buffer. Every key and
 * value is compared byte for byte. Odd seeds read through a 1 MiB cache,
 * even seeds through the default one.
 * A wider sweep: KV_READ_SEEDS=400 KV_READ_STEPS=200, KV_READ_INVERT=1
 * (start above endExclusive).
 */
const utf = (s: string) => new TextEncoder().encode(s);
let db: Db | undefined;
let n = 0;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

function keysOf(rnd: (n: number) => number): Uint8Array[] {
  const out: Uint8Array[] = [
    new Uint8Array(0),
    Uint8Array.of(0),
    Uint8Array.of(0xff),
    Uint8Array.of(0xff, 0xff),
    Uint8Array.of(0xff, 0xff, 0),
    Uint8Array.of(0, 0xff),
    Uint8Array.of(0xff, 0, 0xff),
  ];
  for (let i = 0; i < 300; i++) {
    const depth = rnd(4);
    let s = ["a", "b", "ab", "k/"][rnd(4)]!;
    for (let d = 0; d < depth; d++) s += ["/", "x", "\u0000", "0", "1", "zz"][rnd(6)]!;
    s += String(rnd(40)).padStart(rnd(2) ? 2 : 3, "0");
    out.push(utf(s));
  }
  const long = "L".repeat(300);
  for (let i = 0; i < 40; i++) out.push(utf(`${long}${["", "/", "\u0000"][rnd(3)]}${rnd(25)}`));
  for (let i = 0; i < 20; i++) {
    const size = [1000, 4000, 4100, 6000, 8192][rnd(5)]!;
    const k = new Uint8Array(size).fill(rnd(2) ? 0xff : 0x48);
    k[size - 1] = rnd(256);
    if (rnd(2)) k[size - 2] = rnd(256);
    out.push(k);
  }
  for (let i = 0; i < 10; i++) {
    const k = new Uint8Array(1 + rnd(6)).fill(0xff);
    k[rnd(k.length)] = rnd(3) === 0 ? 0 : 0xfe;
    out.push(k);
  }
  return out;
}

/** The key a value names, for rangeJoin. */
const valueKey = (keys: readonly Uint8Array[], value: Uint8Array): Uint8Array | undefined => {
  if (value.length === 0) return undefined;
  let h = 0;
  for (let i = 0; i < Math.min(value.length, 16); i++) h = (h * 31 + value[i]!) >>> 0;
  return keys[h % keys.length]!;
};

type Entry = { key: Uint8Array; value: Uint8Array };
type Bytes = Uint8Array | undefined;

const same = (a: Bytes, b: Bytes) => (a === undefined || b === undefined ? a === b : compareBytes(a, b) === 0);

/** A short form for a failure message: `show`, the length and a hash of every byte, since `show` keeps 24 bytes as UTF-8. */
function brief(b: Bytes): string {
  if (b === undefined) return "none";
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return `${show(b)}${b.length > 24 ? "" : `(${b.length})`}#${h.toString(16)}`;
}

/** Rows of keys and values, equal byte for byte. */
function expectBytes(got: readonly (readonly Bytes[])[], want: readonly (readonly Bytes[])[], message: string): void {
  const equal = got.length === want.length && got.every((row, i) => row.length === want[i]!.length && row.every((b, j) => same(b, want[i]![j])));
  if (equal) return;
  assert.deepEqual(got.map((row) => row.map(brief).join(" = ")), want.map((row) => row.map(brief).join(" = ")), message);
  throw new Error(`${message}: the bytes differ where the short forms agree`);
}

const rows = (list: readonly Entry[]) => list.map((e) => [e.key, e.value]);
const copy = (b: Uint8Array) => b.slice();

async function run(seed: number): Promise<void> {
  let state = seed;
  const rnd = (k: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % k;
  const keys = keysOf(rnd);
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs, { flushRunBytes: 2048, l0StopRuns: Number.POSITIVE_INFINITY, maxSources: 3 });
  const name = `read-differential-${process.pid}-${++n}`;
  const cache = seed % 2 === 1 ? { cacheBytes: 1 << 20 } : {};
  db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, rowPostMs: 0, ...cache });
  const d = db;
  const oracle = new Oracle();
  let v = 0;
  const value = () => {
    const size = [0, 3, 40, 300, 1500, 5000, 40000][rnd(7)]!;
    const out = new Uint8Array(size).fill("abc".charCodeAt(rnd(3)));
    out.set(utf(`${rnd(1000)}.v${++v}.`).subarray(0, size));
    return out;
  };
  const key = () => keys[rnd(keys.length)]!;
  /** The same bytes, sometimes at an offset inside a larger buffer. */
  const asView = (k: Uint8Array): Uint8Array => {
    if (rnd(4)) return k;
    const buffer = new Uint8Array(k.length + 8).fill(0xff);
    buffer.set(k, 4);
    return buffer.subarray(4, 4 + k.length);
  };
  const bound = (): Uint8Array => {
    const k = key();
    switch (rnd(5)) {
      case 0:
        return k;
      case 1:
        return k.length < 8192 ? Uint8Array.of(...k, 0) : k;
      case 2: {
        if (k.length === 0) return k;
        const up = k.slice();
        up[up.length - 1] = Math.min(255, up[up.length - 1]! + 1);
        return up;
      }
      case 3:
        return new Uint8Array(1 + rnd(4)).fill(0xff);
      default:
        return k.subarray(0, rnd(k.length + 1));
    }
  };
  const log: string[] = [];
  const write = async () => {
    const ops: OracleOp[] = [];
    const count = rnd(3) === 0 ? 40 + rnd(80) : 1 + rnd(4);
    for (let i = 0; i < count; i++) {
      const r = rnd(20);
      if (r < 12) ops.push({ type: "put", key: key(), value: value() });
      else if (r < 18) ops.push({ type: "del", key: key() });
      else {
        const a = bound();
        const b = bound();
        const [start, end] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
        const through = rnd(3) === 0 ? Math.max(0, oracle.head - rnd(5)) : undefined;
        ops.push({
          type: "deleteRange",
          start,
          ...(compareBytes(start, end) < 0 && rnd(4) ? { endExclusive: end } : {}),
          ...(through === undefined ? {} : { through }),
        });
      }
    }
    await d.batch((tx) => applyOps(tx, ops));
    oracle.append(ops);
    log.push(`batch ${ops.length}`);
  };
  const move = async () => {
    const what = rnd(4);
    if (what === 0) {
      await ingest(d);
      log.push("ingest");
    } else if (what === 1) {
      await host.ingest(name);
      log.push("flush");
    } else if (what === 2) {
      await compactHost(host, name);
      log.push("compact");
    }
  };
  const writeOrMove = async () => {
    for (let i = 0; i < 1 + rnd(3); i++) {
      if (rnd(2)) await write();
      else await move();
    }
  };
  const randomRange = (): OracleRange => {
    if (rnd(6) === 0) {
      const k = key();
      const p = prefixBound(k.subarray(0, rnd(k.length + 1)));
      return { ...p, ...(rnd(2) ? { reverse: true } : {}), ...(rnd(2) ? { limit: rnd(6) } : {}) };
    }
    const a = bound();
    const b = bound();
    const [start, end] = compareBytes(a, b) <= 0 || process.env.KV_READ_INVERT ? [a, b] : [b, a];
    return {
      ...(rnd(4) ? { start: asView(start) } : {}),
      ...(rnd(4) && (process.env.KV_READ_INVERT || compareBytes(start, end) < 0) ? { endExclusive: asView(end) } : {}),
      ...(rnd(2) ? { reverse: true } : {}),
      ...(rnd(2) ? { limit: rnd(12) } : {}),
      ...(rnd(3) === 0 ? { offset: rnd(5) } : {}),
      ...(rnd(4) === 0 ? { valueContains: [utf(["a", "b", "v1", ".", "0."][rnd(5)]!)] } : {}),
    };
  };
  const showRange = (range: OracleRange) =>
    JSON.stringify({ ...range, start: range.start && show(range.start), endExclusive: range.endExclusive && show(range.endExclusive), valueContains: range.valueContains?.map(show) });

  const viewAcrossWrites = async () => {
    await d.view(async (snap) => {
      const p = oracle.head;
      expect(snap.seq, `${log.join(", ")}: snap.seq`).toBe(p);
      await writeOrMove();
      const label = `${log.join(", ")}: view at ${p}`;
      const probe = [key(), key(), key()];
      probe.push(probe[0]!);
      expectBytes((await snap.getMany(probe.map(asView))).map((v) => [v]), probe.map((k) => [oracle.valueAt(k, p)]), `${label} getMany`);
      const range = randomRange();
      const want = oracle.rangeAt(range, p);
      const got: Entry[] = [];
      for await (const e of snap.range(range)) got.push(e);
      expectBytes(rows(got), rows(want), `${label} range ${showRange(range)}`);
      expect(await snap.count(range), `${label} count ${showRange(range)}`).toBe(want.length);
      const values = await snap.rangeValues(range, copy);
      expectBytes(values.map((e) => [e.key, e.value]), rows(want), `${label} rangeValues`);
      const joined = await snap.rangeJoin(range, (e) => valueKey(keys, e.value), copy);
      expectBytes(
        joined.map((j) => [j.entry.key, j.entry.value, j.joined]),
        want.map((e) => {
          const k = valueKey(keys, e.value);
          return [e.key, e.value, k && oracle.valueAt(k, p)];
        }),
        `${label} rangeJoin`,
      );
    });
    log.push("view");
  };

  const rangeAcrossWrites = async () => {
    const range = randomRange();
    const it = d.range(range)[Symbol.asyncIterator]();
    const got: Entry[] = [];
    const first = await it.next();
    const p = oracle.head;
    if (!first.done) got.push(first.value);
    await writeOrMove();
    for (let r = await it.next(); !r.done; r = await it.next()) got.push(r.value);
    expectBytes(rows(got), rows(oracle.rangeAt(range, p)), `${log.join(", ")}: range across writes at ${p} ${showRange(range)}`);
  };

  for (let step = 0; step < Number(process.env.KV_READ_STEPS ?? 60); step++) {
    const what = rnd(10);
    if (what < 5) await write();
    else if (what < 8) await move();
    else if (what === 8) await viewAcrossWrites();
    else await rangeAcrossWrites();

    const label = log.join(", ");
    const probe = key();
    expectBytes([[await d.get(asView(probe))]], [[oracle.valueAt(probe)]], `${label}: get ${brief(probe)}`);
    const many = [key(), key(), key(), new Uint8Array(0)];
    many.push(many[rnd(many.length)]!, many[0]!);
    const wantMany = many.map((k) => [oracle.valueAt(k)]);
    expectBytes((await d.getMany(many.map(asView))).map((v) => [v]), wantMany, `${label}: getMany`);
    expectBytes((await d.getMany(many, copy)).map((v) => [v]), wantMany, `${label}: getMany decode`);
    for (let r = 0; r < 3; r++) {
      const range = randomRange();
      const want = oracle.rangeAt(range);
      const got: Entry[] = [];
      for await (const e of d.range(range)) got.push(e);
      expectBytes(rows(got), rows(want), `${label}: range ${showRange(range)}`);
      expect(await d.count(range), `${label}: count ${showRange(range)}`).toBe(want.length);
    }
  }
}

for (const seed of Array.from({ length: Number(process.env.KV_READ_SEEDS ?? 8) }, (_, i) => i + 1)) {
  it(`reads agree with the oracle over many and long keys, several blocks, L0 over L1, and views and scans across writes (seed ${seed}, ${seed % 2 === 1 ? "1 MiB" : "default"} cache)`, async () => {
    expect.hasAssertions();
    await run(seed);
  }, 120_000);
}
