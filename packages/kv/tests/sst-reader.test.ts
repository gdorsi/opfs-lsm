import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { PageCache } from "../src/store/page-cache.js";
import type { SstEntry } from "../src/store/sst.js";
import { decodeSst, encodeSstRef, SST_BLOCK_TARGET, sstBlockIndex, sstGet, sstRunEnd } from "./oracle/sst-ref.js";
import { SstReader } from "../src/store/sst-reader.js";
import { coalesceReads } from "../src/opfs/coalesce-reads.js";
import { bytesFile, cacheUsage, drain, loadsDone, runGet } from "./runs.js";
import { cat, EDGE_CASES, indexWorkload, utf } from "./sst-workloads.js";

class Reads {
  count = 0;
  bytes = 0;
  /** The reads among `count` that start past the run's blocks: its Bloom filter, index and footer. */
  tails = 0;
}

/** How a read of a run's tail goes. `read` is the read itself. */
type Tail = (read: () => Promise<Uint8Array>) => Promise<Uint8Array>;

function openRun(body: Uint8Array, cache: PageCache, reads = new Reads(), tail: Tail = (read) => read()): SstReader {
  const file = bytesFile(body);
  const end = sstRunEnd(body);
  const index = sstBlockIndex(body);
  const dataEnd = index.blockStart[index.sepEnd.length]!;
  return new SstReader(
    {
      size: file.size,
      read(offset, length) {
        reads.count++;
        if (offset < dataEnd) return file.read(offset, length);
        reads.tails++;
        return tail(() => file.read(offset, length));
      },
    },
    cache,
    end,
  );
}

const show = (e: SstEntry | undefined) => (e ? `${[...e.key]}:${e.kind}:${e.seq}:${e.kind === "put" ? [...e.value] : ""}` : "none");

/** Every key, the key just after it, and keys before and after the run. */
function probesOf(all: readonly SstEntry[]): Uint8Array[] {
  return [new Uint8Array(0), utf("a"), utf("i/"), utf("z"), Uint8Array.of(0xff, 0xff), ...all.flatMap((e) => [e.key, cat(e.key, Uint8Array.of(0))])];
}

function gapWorkload(): SstEntry[] {
  return Array.from({ length: 900 }, (_, i) =>
    i % 7 === 3
      ? { kind: "del" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), seq: i + 1 }
      : { kind: "put" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), value: utf("v".repeat(i % 50)), seq: i + 1 },
  );
}

describe("lazy sst reader", () => {
  const cases: [string, SstEntry[]][] = [
    ["multi-index workload", indexWorkload(2_000)],
    ["keys every other number, with gaps", gapWorkload()],
    ...Object.entries(EDGE_CASES),
  ];

  for (const [name, entries] of cases) {
    it(`get agrees with decodeSst: ${name}`, async () => {
      const body = encodeSstRef(entries);
      const all = decodeSst(body);
      const reader = openRun(body, new PageCache());
      const probes = probesOf(all);
      const got: string[] = [];
      for (const k of probes) got.push(show(await runGet(reader, k)));
      expect(got).toEqual(probes.map((k) => show(sstGet(all, k))));
    });
  }

  it("a get answers the same with the Bloom filter absent, loading and resident", async () => {
    const body = encodeSstRef(indexWorkload(2_000));
    const all = decodeSst(body);
    const probes = probesOf(all);
    const absentKeys = all.filter((_, i) => i % 400 === 0).map((e) => cat(e.key, Uint8Array.of(0)));
    const tails: Record<"absent" | "loading" | "resident", Tail> = {
      absent: () => Promise.reject(new Error("disk")),
      loading: () => new Promise(() => {}),
      resident: (read) => read(),
    };
    const blockReads = { absent: 0, loading: 0, resident: 0 };
    for (const state of ["absent", "loading", "resident"] as const) {
      const reads = new Reads();
      const cache = new PageCache();
      const reader = openRun(body, cache, reads, tails[state]);
      // Starts the filter's load. Only the read that loads lets it land.
      reader.get(all[0]!.key);
      if (state !== "loading") await loadsDone(cache);
      expect(cacheUsage(cache).metadata > 0, `filter ${state}`).toBe(state === "resident");

      reads.count = reads.tails = 0;
      for (const k of absentKeys) expect(await runGet(reader, k), `filter ${state}`).toBeUndefined();
      blockReads[state] = reads.count - reads.tails;

      const got: string[] = [];
      for (const k of probes) got.push(show(await runGet(reader, k)));
      expect(got, `filter ${state}`).toEqual(probes.map((k) => show(sstGet(all, k))));
      expect(cacheUsage(cache).metadata > 0, `filter ${state}`).toBe(state === "resident");
    }
    // Without its filter a run reads the block of a key it does not hold.
    expect(blockReads.loading).toBe(blockReads.absent);
    expect(blockReads.resident).toBeLessThan(blockReads.absent);
  });

  it("a cold get reads its block while the read of the Bloom filter is still out", async () => {
    const reads = new Reads();
    const body = encodeSstRef(indexWorkload(2_000));
    const e = decodeSst(body)[5_000]!;
    const reader = openRun(body, new PageCache(), reads, () => new Promise(() => {}));
    expect(show(await runGet(reader, e.key))).toBe(show(e));
    expect(reads).toMatchObject({ count: 2, tails: 1 });
  });

  it("with a budget larger than the database, a second pass of gets reads nothing", async () => {
    const reads = new Reads();
    const body = encodeSstRef(indexWorkload(2_000));
    const reader = openRun(body, new PageCache(), reads);
    const all = decodeSst(body);
    for (const e of all) await runGet(reader, e.key);
    expect(reads.count).toBeGreaterThan(0);
    reads.count = 0;
    for (const e of all) expect(show(await runGet(reader, e.key))).toBe(show(e));
    expect(reads.count).toBe(0);
  });

  it("with a budget of one Bloom filter and one block, evicts blocks and filters and still answers every get", async () => {
    const workload = indexWorkload(6_000);
    const half = workload.length >> 1;
    const bodies = [encodeSstRef(workload.slice(0, half)), encodeSstRef(workload.slice(half))];

    const metaBytes: number[] = [];
    for (const body of bodies) {
      const cache = new PageCache();
      openRun(body, cache).get(decodeSst(body)[0]!.key);
      await loadsDone(cache);
      metaBytes.push(cacheUsage(cache).metadata);
    }
    expect(Math.min(...metaBytes)).toBeGreaterThan(0);
    const budget = Math.max(...metaBytes) + SST_BLOCK_TARGET;
    const totalMeta = metaBytes.reduce((a, b) => a + b, 0);

    const reads = new Reads();
    const cache = new PageCache(budget);
    const runs: { reader: SstReader; all: SstEntry[] }[] = [];
    for (const body of bodies) runs.push({ reader: openRun(body, cache, reads), all: decodeSst(body) });

    let minMeta = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      reads.count = 0;
      // Round-robin across runs so each run's filter competes with the other's blocks.
      const longest = Math.max(...runs.map((r) => r.all.length));
      for (let i = 0; i < longest; i += 7) {
        for (const { reader, all } of runs) {
          const e = all[(i * 7919) % all.length]!;
          expect(show(await runGet(reader, e.key))).toBe(show(e));
          const missKey = cat(e.key, Uint8Array.of(0));
          expect(show(await runGet(reader, missKey))).toBe(show(sstGet(all, missKey)));
          const u = cacheUsage(cache);
          expect(u.resident).toBeLessThanOrEqual(u.budget);
          minMeta = Math.min(minMeta, u.metadata);
        }
      }
      expect(reads.count).toBeGreaterThan(0);
    }
    expect(minMeta).toBeLessThan(totalMeta);
  });

  it("concurrent misses on one block share one read", async () => {
    const body = encodeSstRef(indexWorkload(2_000));
    const all = decodeSst(body).sort((a, b) => compareBytes(a.key, b.key));
    const sameBlock = all.slice(100, 104).map((e) => e.key);

    const alone = new Reads();
    const one = openRun(body, new PageCache(), alone);
    await runGet(one, sameBlock[0]!);

    const together = new Reads();
    const many = openRun(body, new PageCache(), together);
    const got = await Promise.all(sameBlock.map((k) => runGet(many, k)));

    expect(got.map(show)).toEqual(all.slice(100, 104).map(show));
    expect(together.count).toBe(alone.count);
  });

  describe("a cold scan through coalesced reads", () => {
    const entries: SstEntry[] = Array.from({ length: 15_000 }, (_, i) => ({
      kind: "put",
      key: utf(`k${String(i).padStart(6, "0")}`),
      value: utf(`v${i}`.padEnd(200, ".")),
      seq: i + 1,
    }));
    const body = encodeSstRef(entries);
    const end = sstRunEnd(body);
    const index = sstBlockIndex(body);
    const blocks = index.sepEnd.length;
    const dataEnd = index.blockStart[blocks]!;

    function coldRun(reads: Reads): SstReader {
      const read = coalesceReads(async (offset, length) => {
        reads.count++;
        reads.bytes += length;
        if (offset + length > dataEnd) reads.tails++;
        return body.slice(offset, offset + length).buffer;
      });
      return new SstReader({ size: body.byteLength, read }, new PageCache(), end);
    }

    for (const reverse of [false, true]) {
      it(`reads ${reverse ? "back" : "forward"} through every block in a few reads, and nothing past the blocks`, async () => {
        const reads = new Reads();
        const got = await drain(coldRun(reads).cursor(undefined, reverse));
        const want = reverse ? [...entries].reverse() : entries;
        expect(got.map(show)).toEqual(want.map(show));
        expect(blocks).toBeGreaterThan(80);
        expect(reads.count).toBeLessThan(blocks / 5);
        expect(reads.bytes).toBe(dataEnd);
        expect(reads.tails).toBe(0);
      });
    }

    it("returns exactly the keys inside bounds that fall on, between and across block edges, both ways", async () => {
      const reader = coldRun(new Reads());
      for (let i = 400; i < 700; i += 7) {
        for (const start of [entries[i]!.key, cat(entries[i]!.key, Uint8Array.of(0))]) {
          for (const width of [0, 1, 13, 160]) {
            for (const endExclusive of [entries[i + width]!.key, cat(entries[i + width]!.key, Uint8Array.of(0))]) {
              const want = entries.filter((e) => compareBytes(e.key, start) >= 0 && compareBytes(e.key, endExclusive) < 0);
              expect((await drain(reader.cursor({ start, endExclusive }))).map(show)).toEqual(want.map(show));
              expect((await drain(reader.cursor({ start, endExclusive }, true))).map(show)).toEqual(want.reverse().map(show));
            }
          }
        }
      }
    });

    it("reads no block past the one a short scan ends in", async () => {
      const reads = new Reads();
      expect(await drain(coldRun(reads).cursor({ start: utf("k000010"), endExclusive: utf("k000020") }))).toHaveLength(10);
      expect(reads).toMatchObject({ count: 1, bytes: index.blockStart[1], tails: 0 });
    });

    it("reads no block that starts at a scan's end bound", async () => {
      // Blocks start every 150 or so keys, so some of these bounds are the first key of a block.
      for (let i = 400; i < 700; i++) {
        const atKey = new Reads();
        const beforeKey = new Reads();
        expect(await drain(coldRun(atKey).cursor({ endExclusive: entries[i]!.key }))).toHaveLength(i);
        expect(await drain(coldRun(beforeKey).cursor({ endExclusive: cat(entries[i - 1]!.key, Uint8Array.of(0)) }))).toHaveLength(i);
        expect(atKey.bytes, `end bound ${i}`).toBe(beforeKey.bytes);
      }
    });
  });
});
