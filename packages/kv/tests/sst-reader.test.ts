import { beforeAll, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { settle } from "../src/store/cursor.js";
import { encodeSst as encodeWasm, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { PageCache } from "../src/store/page-cache.js";
import { decodeSst, encodeSst, sstGet, sstKeyRange, type SstEntry } from "../src/store/sst.js";
import { PAGE_TARGET, SstReader } from "../src/store/sst-reader.js";
import { bytesFile } from "./runs.js";
import { cat, EDGE_CASES, indexWorkload, utf } from "./sst-workloads.js";

class Reads {
  count = 0;
}

function openRun(body: Uint8Array, cache: PageCache, reads = new Reads()): SstReader {
  const file = bytesFile(body);
  return new SstReader(
    { size: file.size, read: (offset, length) => (reads.count++, file.read(offset, length)) },
    cache,
    sstKeyRange(body),
  );
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
        const reader = openRun(body, new PageCache());
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
    const reader = openRun(encodeSst(entries), new PageCache());
    expect((await settle(() => reader.get(utf("k00149999"))))?.seq).toBe(n);
    expect((await settle(() => reader.get(utf("k00000000"))))?.seq).toBe(1);
    expect(await settle(() => reader.get(utf("k00150000")))).toBeUndefined();
  });

  it("with a budget larger than the database, a second pass of gets reads nothing", async () => {
    const reads = new Reads();
    const cache = new PageCache();
    const runs: { reader: SstReader; all: SstEntry[] }[] = [];
    for (const [, body] of await encodings(indexWorkload(2_000))) {
      runs.push({ reader: openRun(body, cache, reads), all: decodeSst(body) });
    }
    for (const { reader, all } of runs) for (const e of all) await settle(() => reader.get(e.key));
    expect(reads.count).toBeGreaterThan(0);
    reads.count = 0;
    for (const { reader, all } of runs) {
      for (const e of all) expect(show(await settle(() => reader.get(e.key)))).toBe(show(e));
    }
    expect(reads.count).toBe(0);
  });

  it("with a budget smaller than one run, evicts pages and metadata and still answers every get", async () => {
    const workload = indexWorkload(6_000);
    const half = workload.length >> 1;
    const bodies = [...(await encodings(workload.slice(0, half))), ...(await encodings(workload.slice(half)))].map(([, b]) => b);

    const metaBytes: number[] = [];
    for (const body of bodies) {
      const cache = new PageCache();
      const reader = openRun(body, cache);
      await settle(() => reader.get(utf("probe")));
      metaBytes.push(cache.usage().metadata);
    }
    const budget = Math.max(...metaBytes) + 2 * PAGE_TARGET;
    const totalMeta = metaBytes.reduce((a, b) => a + b, 0);
    expect(budget).toBeLessThan(Math.min(...bodies.map((b) => b.byteLength)));

    const reads = new Reads();
    const cache = new PageCache(budget);
    const runs: { reader: SstReader; all: SstEntry[] }[] = [];
    for (const body of bodies) runs.push({ reader: openRun(body, cache, reads), all: decodeSst(body) });

    let minMeta = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      reads.count = 0;
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
      expect(reads.count).toBeGreaterThan(0);
    }
    expect(minMeta).toBeLessThan(totalMeta);
  });

  it("concurrent misses on one page share one read", async () => {
    const [, body] = (await encodings(indexWorkload(2_000)))[0]!;
    const all = decodeSst(body).sort((a, b) => compareBytes(a.key, b.key));
    const sameBlock = all.slice(100, 104).map((e) => e.key);

    const alone = new Reads();
    const one = openRun(body, new PageCache(), alone);
    await settle(() => one.get(sameBlock[0]!));

    const together = new Reads();
    const many = openRun(body, new PageCache(), together);
    const got = await Promise.all(sameBlock.map((k) => settle(() => many.get(k))));

    expect(got.map(show)).toEqual(all.slice(100, 104).map(show));
    expect(together.count).toBe(alone.count);
  });
});
