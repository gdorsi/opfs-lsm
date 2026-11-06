import { beforeAll, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import { settle } from "../src/store/cursor.js";
import { encodeSst as encodeWasm, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { PageCache } from "../src/store/page-cache.js";
import { decodeSst, encodeSst, sstGet, type SstEntry } from "../src/store/sst.js";
import { PAGE_TARGET, runFile, SstReader } from "../src/store/sst-reader.js";
import { cat, EDGE_CASES, indexWorkload, utf } from "./sst-workloads.js";

class CountingFs extends MemoryFs {
  reads = 0;
  override async read(path: string, offset: number, length: number) {
    this.reads++;
    return super.read(path, offset, length);
  }
}

let nextPath = 0;
async function openRun(fs: MemoryFs, body: Uint8Array, cache: PageCache): Promise<SstReader> {
  const path = `l0/${nextPath++}.sst`;
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return new SstReader(runFile(fs, path, body.byteLength), cache);
}

const show = (e: SstEntry | undefined) => (e ? `${[...e.key]}:${e.kind}:${e.seq}:${e.kind === "put" ? [...e.value] : ""}` : "none");

/** Every key, the key just after it, and keys before and after the run. */
function probesOf(all: readonly SstEntry[]): Uint8Array[] {
  return [new Uint8Array(0), utf("a"), utf("i/"), utf("z"), Uint8Array.of(0xff, 0xff), ...all.flatMap((e) => [e.key, cat(e.key, Uint8Array.of(0))])];
}

async function encodings(entries: readonly SstEntry[]): Promise<[string, Uint8Array][]> {
  return [
    ["raw", encodeSst(entries)],
    ["lz4", await encodeWasm(entries, "lz4")],
  ];
}

function gapWorkload(): SstEntry[] {
  return Array.from({ length: 900 }, (_, i) =>
    i % 7 === 3
      ? { kind: "del" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), seq: i + 1 }
      : { kind: "put" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), value: utf("v".repeat(i % 50)), seq: i + 1 },
  );
}

describe("lazy sst reader", () => {
  beforeAll(async () => {
    await ensureEngine();
    expect(engineUsingWasm()).toBe(true);
  });

  const cases: [string, SstEntry[]][] = [
    ["multi-index workload", indexWorkload(2_000)],
    ["keys every other number, with gaps", gapWorkload()],
    ...Object.entries(EDGE_CASES),
  ];

  for (const [name, entries] of cases) {
    it(`get agrees with decodeSst: ${name}`, async () => {
      for (const [, body] of await encodings(entries)) {
        const all = decodeSst(body);
        const reader = await openRun(new MemoryFs(), body, new PageCache());
        const probes = probesOf(all);
        const got: string[] = [];
        for (const k of probes) got.push(show(await settle(() => reader.get(k))));
        expect(got).toEqual(probes.map((k) => show(sstGet(all, k))));
      }
    });
  }

  it("reads a run whose Bloom filter and index outgrow the first tail read", async () => {
    const n = 150_000;
    const entries = Array.from({ length: n }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(8, "0")}`),
      value: utf("v"),
      seq: i + 1,
    }));
    const reader = await openRun(new MemoryFs(), encodeSst(entries), new PageCache());
    expect((await settle(() => reader.get(utf("k00149999"))))?.seq).toBe(n);
    expect((await settle(() => reader.get(utf("k00000000"))))?.seq).toBe(1);
    expect(await settle(() => reader.get(utf("k00150000")))).toBeUndefined();
  });

  it("with a budget larger than the database, a second pass of gets reads nothing", async () => {
    const fs = new CountingFs();
    const cache = new PageCache();
    const runs: { reader: SstReader; all: SstEntry[] }[] = [];
    for (const [, body] of await encodings(indexWorkload(2_000))) {
      runs.push({ reader: await openRun(fs, body, cache), all: decodeSst(body) });
    }
    for (const { reader, all } of runs) for (const e of all) await settle(() => reader.get(e.key));
    expect(fs.reads).toBeGreaterThan(0);
    fs.reads = 0;
    for (const { reader, all } of runs) {
      for (const e of all) expect(show(await settle(() => reader.get(e.key)))).toBe(show(e));
    }
    expect(fs.reads).toBe(0);
  });

  it("with a budget smaller than one run, evicts pages and metadata and still answers every get", async () => {
    const workload = indexWorkload(6_000);
    const half = workload.length >> 1;
    const bodies = [...(await encodings(workload.slice(0, half))), ...(await encodings(workload.slice(half)))].map(([, b]) => b);

    const metaBytes: number[] = [];
    for (const body of bodies) {
      const cache = new PageCache();
      const reader = await openRun(new MemoryFs(), body, cache);
      await settle(() => reader.get(utf("probe")));
      metaBytes.push(cache.usage().metadata);
    }
    const budget = Math.max(...metaBytes) + 2 * PAGE_TARGET;
    const totalMeta = metaBytes.reduce((a, b) => a + b, 0);
    expect(budget).toBeLessThan(Math.min(...bodies.map((b) => b.byteLength)));

    const fs = new CountingFs();
    const cache = new PageCache(budget);
    const runs: { reader: SstReader; all: SstEntry[] }[] = [];
    for (const body of bodies) runs.push({ reader: await openRun(fs, body, cache), all: decodeSst(body) });

    let minMeta = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      fs.reads = 0;
      // Round-robin across runs so each run's metadata competes with the others' pages.
      const longest = Math.max(...runs.map((r) => r.all.length));
      for (let i = 0; i < longest; i += 7) {
        for (const { reader, all } of runs) {
          const e = all[(i * 7919) % all.length]!;
          expect(show(await settle(() => reader.get(e.key)))).toBe(show(e));
          const missKey = cat(e.key, Uint8Array.of(0));
          expect(show(await settle(() => reader.get(missKey)))).toBe(show(sstGet(all, missKey)));
          const u = cache.usage();
          expect(u.resident).toBeLessThanOrEqual(Math.max(u.budget, u.pinned));
          minMeta = Math.min(minMeta, u.metadata);
        }
      }
      expect(fs.reads).toBeGreaterThan(0);
    }
    expect(minMeta).toBeLessThan(totalMeta);
  });

  it("concurrent misses on one page share one read", async () => {
    const [, body] = (await encodings(indexWorkload(2_000)))[0]!;
    const all = decodeSst(body).sort((a, b) => compareBytes(a.key, b.key));
    const sameBlock = all.slice(100, 104).map((e) => e.key);

    const alone = new CountingFs();
    const one = await openRun(alone, body, new PageCache());
    await settle(() => one.get(sameBlock[0]!));

    const together = new CountingFs();
    const many = await openRun(together, body, new PageCache());
    const got = await Promise.all(sameBlock.map((k) => settle(() => many.get(k))));

    expect(got.map(show)).toEqual(all.slice(100, 104).map(show));
    expect(together.reads).toBe(alone.reads);
  });

  it("rejects a read that returns fewer bytes than asked", async () => {
    class ShortFs extends MemoryFs {
      override async read(path: string, offset: number, length: number) {
        const buf = await super.read(path, offset, length);
        return buf?.subarray(1);
      }
    }
    const reader = await openRun(new ShortFs(), encodeSst(indexWorkload(10)), new PageCache());
    await expect(settle(() => reader.get(utf("t/")))).rejects.toThrow(CorruptDatabaseError);
  });
});
