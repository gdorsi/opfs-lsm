import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { compareBytes, containsAll } from "../src/bytes.js";
import { Miss, untilHit, type LayerCursor, type ScanBounds } from "../src/store/cursor.js";
import { countOf, latestSstEntry, liveStep, matchingStep, runLevels, type RunLevel } from "../src/store/read.js";
import { scanStep } from "../src/view.js";
import { NO_ROWS } from "../src/store/memtable.js";
import type { SstEntry } from "../src/store/sst.js";
import { encodeSstRef, sstBlockIndex, sstRunEnd } from "./oracle/sst-ref.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";
import { PageCache } from "../src/store/page-cache.js";
import { entries, loadsDone, ownedEntry, readerOfBytes, runGet } from "./runs.js";
import { coversRun, NO_MARKS, type Mark, type Marks } from "../src/store/marks.js";
import { ensureEngine } from "../src/store/engine.js";

// `valueContains` scans a run's blocks in the wasm engine.
beforeAll(ensureEngine);

const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(4, "0")}`);

function run(keys: number[], tag: string): SstReader {
  const entries: SstEntry[] = keys.map((i) =>
    i % 5 === 0
      ? { kind: "del", key: key(i), seq: 1 }
      : { kind: "put", key: key(i), value: enc.encode(`${tag}${i}`), seq: 1 },
  );
  return readerOfBytes(encodeSstRef(entries, 64));
}

/** The level a run path names: `l<n>/`. */
const levelOf = (path: string) => Number(path[1]);

/** Newest first: two overlapping L0 runs, then L1 and L2 cut into disjoint runs with gaps. */
function layout() {
  const l2 = [[0, 30], [40, 70], [75, 120]].map(([a, b]) => run(range(a!, b!, 1), "l2:"));
  const l1 = [[10, 50], [60, 90]].map(([a, b]) => run(range(a!, b!, 3), "l1:"));
  const l0 = [run(range(5, 100, 7), "l0a:"), run(range(0, 110, 11), "l0b:")];
  const paths = [
    "l0/2-2.sst",
    "l0/1-1.sst",
    ...l1.map((_, i) => `l1/c1.${i}-0.sst`),
    ...l2.map((_, i) => `l2/c1.${i}-0.sst`),
  ];
  return { paths, readers: [...l0, ...l1, ...l2] };
}

/** The bodies of `layout`, newest first, with the same paths. */
function layoutBodies() {
  const body = (keys: number[], tag: string) =>
    encodeSstRef(keys.map((i): SstEntry => (i % 5 === 0 ? { kind: "del", key: key(i), seq: 1 } : { kind: "put", key: key(i), value: enc.encode(`${tag}${i}`), seq: 1 })), 64);
  const l2 = [[0, 30], [40, 70], [75, 120]].map(([a, b]) => body(range(a!, b!, 1), "l2:"));
  const l1 = [[10, 50], [60, 90]].map(([a, b]) => body(range(a!, b!, 3), "l1:"));
  const l0 = [body(range(5, 100, 7), "l0a:"), body(range(0, 110, 11), "l0b:")];
  return { paths: layout().paths, bodies: [...l0, ...l1, ...l2] };
}

/** The file reads of one run: of its blocks, and of its tail, where its Bloom filter is. */
type Reads = { blocks: number; tails: number };

/** A reader of `body` that counts each file read in `reads`. */
function countedReader(body: Uint8Array, reads: Reads, cache = new PageCache()): SstReader {
  const file = bytesFile(body);
  const end = sstRunEnd(body);
  const index = sstBlockIndex(body);
  const dataEnd = index.blockStart[index.sepEnd.length]!;
  const read = (offset: number, length: number) => (reads[offset < dataEnd ? "blocks" : "tails"]++, file.read(offset, length));
  return new SstReader({ size: file.size, read }, cache, end);
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i += step) out.push(i);
  return out;
}

function mergeCursors(cursors: readonly LayerCursor[], marks: Marks, limit?: number, reverse = false) {
  return entries(liveStep(cursors, marks, reverse), limit);
}

async function scan(cursors: readonly LayerCursor[], limit?: number, reverse?: boolean): Promise<string[]> {
  return (await mergeCursors(cursors, NO_MARKS, limit, reverse)).map((e) => `${dec.decode(e.key)}=${dec.decode(e.value)}`);
}

describe("runLevels", () => {
  it("scans the same rows as one cursor per run, for every bound", async () => {
    const { paths, readers } = layout();
    const levels = runLevels(paths.map(levelOf), readers);
    expect(levels).toHaveLength(4);
    const bounds = [undefined, ...range(-1, 125, 4).flatMap((a) =>
      range(a, 130, 9).map((b) => ({ start: key(a < 0 ? 0 : a), endExclusive: key(b) })),
    ), ...range(0, 125, 6).map((a) => ({ start: key(a) }))];
    for (const b of bounds) {
      for (const limit of [undefined, 1, 7]) {
        const want = await scan(readers.map((r) => r.cursor(b)), limit);
        const got = await scan(levels.map((l) => l.cursor(b)), limit);
        expect(got).toEqual(want);
      }
    }
  });

  it("scans the forward rows backward, for every bound", async () => {
    const { paths, readers } = layout();
    const levels = runLevels(paths.map(levelOf), readers);
    const bounds = [undefined, ...range(-1, 125, 4).flatMap((a) =>
      range(a, 130, 9).map((b) => ({ start: key(a < 0 ? 0 : a), endExclusive: key(b) })),
    ), ...range(0, 125, 6).map((a) => ({ start: key(a) })), ...range(0, 125, 6).map((b) => ({ endExclusive: key(b) }))];
    for (const b of bounds) {
      const forward = await scan(levels.map((l) => l.cursor(b)));
      for (const limit of [undefined, 1, 7]) {
        expect(await scan(levels.map((l) => l.cursor(b, true)), limit, true)).toEqual([...forward].reverse().slice(0, limit));
        expect(await scan(readers.map((r) => r.cursor(b, true)), limit, true)).toEqual([...forward].reverse().slice(0, limit));
      }
    }
  });

  it("gets the same entry as asking every run newest first", async () => {
    const { paths, readers } = layout();
    const levels = runLevels(paths.map(levelOf), readers);
    const show = (e: SstEntry | undefined) =>
      e && `${dec.decode(e.key)}:${e.kind}:${e.kind === "put" ? dec.decode(e.value) : ""}`;
    for (let i = -2; i < 125; i++) {
      const all = await Promise.all(readers.map((r) => runGet(r, key(i))));
      const want = all.find((e) => e !== undefined);
      expect(show(await untilHit(() => ownedEntry(latestSstEntry(levels, key(i)), key(i))))).toEqual(show(want));
    }
  });

  it("a cold get starts at once the read of the key's block in every level whose range holds the key", () => {
    for (let i = -2; i < 125; i++) {
      const { paths, bodies } = layoutBodies();
      const reads = bodies.map((): Reads => ({ blocks: 0, tails: 0 }));
      const readers = bodies.map((body, r) => countedReader(body, reads[r]!));
      const got = latestSstEntry(runLevels(paths.map(levelOf), readers), key(i));
      const holding = bodies.map((body) => {
        const { smallest, largest } = sstRunEnd(body).range!;
        return compareBytes(smallest, key(i)) <= 0 && compareBytes(key(i), largest) <= 0 ? 1 : 0;
      });
      expect(got instanceof Miss, `key ${i}`).toBe(holding.includes(1));
      expect(reads, `key ${i}`).toEqual(holding.map((n) => ({ blocks: n, tails: n })));
    }
  });

  it("with its Bloom filters resident, a get of a key the newest level holds reads no block of an older level", async () => {
    const versions = ["new", "mid", "old"].map((tag) =>
      encodeSstRef(range(0, 40, 1).map((i) => ({ kind: "put" as const, key: key(i), value: enc.encode(tag), seq: 1 })), 64),
    );
    const cache = new PageCache();
    const reads = versions.map((): Reads => ({ blocks: 0, tails: 0 }));
    const readers = versions.map((body, r) => countedReader(body, reads[r]!, cache));
    const levels = runLevels([0, 0, 1], readers);
    // A get of a key in another block leaves every filter resident and the block of `key(30)` unread.
    for (const reader of readers) await runGet(reader, key(0));
    await loadsDone(cache);
    expect(reads).toEqual(versions.map(() => ({ blocks: 1, tails: 1 })));

    const got = await untilHit(() => ownedEntry(latestSstEntry(levels, key(30)), key(30)));
    expect(got?.kind === "put" && dec.decode(got.value)).toBe("new");
    expect(reads.map((r) => r.blocks)).toEqual([2, 1, 1]);
  });

  it("an older run that fails to load fails only the reads that reach it", async () => {
    const newer = encodeSstRef([{ kind: "put", key: key(1), value: enc.encode("new"), seq: 2 }], 64);
    const older = encodeSstRef([1, 2].map((i) => ({ kind: "put" as const, key: key(i), value: enc.encode("old"), seq: 1 })), 64);
    const broken = new Error("unreadable run");
    const open = () => runLevels([0, 1], [
      readerOfBytes(newer),
      new SstReader({ size: older.byteLength, read: () => Promise.reject(broken) }, new PageCache(), sstRunEnd(older)),
    ]);
    const levels = open();
    const got = await untilHit(() => ownedEntry(latestSstEntry(levels, key(1)), key(1)));
    expect(got?.kind === "put" && dec.decode(got.value)).toBe("new");
    const fresh = open();
    await expect(untilHit(() => latestSstEntry(fresh, key(2)))).rejects.toBe(broken);
  });

  it("keeps runs in key order inside a level", async () => {
    const { paths, readers } = layout();
    const rows = await scan(runLevels(paths.map(levelOf), readers).map((l) => l.cursor()));
    const keys = rows.map((r) => enc.encode(r.split("=")[0]!));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
  });
});

describe("a scan under range deletes", () => {
  const KEYS = 16;
  const cellArb = fc.option(fc.constantFrom("put", "del"), { nil: undefined, freq: 2 });
  /** Newest first: up to three L0 runs, then one level of two disjoint runs. Every version is older than every mark. */
  const layoutArb = fc.record({
    l0: fc.array(fc.array(cellArb, { minLength: KEYS, maxLength: KEYS }), { minLength: 1, maxLength: 3 }),
    l1: fc.array(cellArb, { minLength: KEYS, maxLength: KEYS }),
    split: fc.integer({ min: 1, max: KEYS - 1 }),
  });
  const markArb = fc
    .record({ a: fc.integer({ min: 0, max: KEYS }), span: fc.option(fc.integer({ min: 1, max: KEYS }), { nil: undefined }), through: fc.nat() })
    .map(({ a, span, through }) => ({ start: key(a), ...(span === undefined ? {} : { endExclusive: key(a + span) }), through }));
  const boundsArb = fc.record({
    start: fc.option(fc.integer({ min: 0, max: KEYS }), { nil: undefined }),
    end: fc.option(fc.integer({ min: 0, max: KEYS + 1 }), { nil: undefined }),
  });

  /** Readers and paths for `layout`, seqs assigned oldest first, each run claiming the last seq it holds. */
  function build(layout: { l0: (string | undefined)[][]; l1: (string | undefined)[]; split: number }) {
    let seq = 0;
    const runOf = (cells: (string | undefined)[], from: number, to: number, tag: string, claim?: number) => {
      const entries: SstEntry[] = [];
      for (let i = from; i < to; i++) {
        const kind = cells[i];
        if (kind === "del") entries.push({ kind, key: key(i), seq: ++seq });
        else if (kind === "put") entries.push({ kind, key: key(i), value: enc.encode(`${tag}${i % 3}`), seq: ++seq });
      }
      if (entries.length === 0) return undefined;
      const body = encodeSstRef(entries, 64);
      return { body, marksThrough: claim ?? seq };
    };
    const l1 = [runOf(layout.l1, 0, layout.split, "l1:"), runOf(layout.l1, layout.split, KEYS, "l1:")];
    const l1Through = seq;
    const l0 = layout.l0.map((cells, i) => runOf(cells, 0, KEYS, `l0${i}:`)).reverse();
    const runs = [
      ...l0.flatMap((r, i) => (r ? [{ ...r, path: `l0/${i}.sst` }] : [])),
      ...l1.flatMap((r, i) => (r ? [{ ...r, marksThrough: l1Through, path: `l1/c1.${i}.sst` }] : [])),
    ];
    return { runs, maxSeq: seq };
  }

  const show = (e: { key: Uint8Array; value: Uint8Array }) => `${dec.decode(e.key)}=${dec.decode(e.value)}`;

  it("yields what reading every run yields, forward, backward and with valueContains", async () => {
    let passedOver = 0;
    await fc.assert(
      fc.asyncProperty(layoutArb, fc.array(markArb, { maxLength: 3 }), boundsArb, fc.constantFrom("0", "1", "l0"), async (layout, raw, b, pattern) => {
        const { runs, maxSeq } = build(layout);
        const marks: Mark[] = raw.map((m) => ({ ...m, through: 1 + (m.through % (maxSeq + 1)), at: maxSeq + 2 }));
        const bounds: ScanBounds = {
          ...(b.start === undefined ? {} : { start: key(b.start) }),
          ...(b.end === undefined ? {} : { endExclusive: key(b.end) }),
        };
        const cache = new PageCache();
        const readers = runs.map((r) => new SstReader(bytesFile(r.body), cache, sstRunEnd(r.body), r.marksThrough));
        const levels = runLevels(runs.map((r) => levelOf(r.path)), readers);
        passedOver += readers.filter((r) => r.range && coversRun(marks, { range: r.range, marksThrough: r.marksThrough }, bounds)).length;
        const patterns = [enc.encode(pattern)];
        for (const reverse of [false, true]) {
          const want = (await mergeCursors(levels.map((l) => l.cursor(bounds, reverse)), marks, undefined, reverse)).map(show);
          const got = (await mergeCursors(levels.map((l) => l.cursor(bounds, reverse, marks)), marks, undefined, reverse)).map(show);
          expect(got).toEqual(want);
          const matching = (await entries(matchingStep(NO_ROWS, levels, patterns, marks, bounds, reverse))).map(show);
          expect(matching).toEqual(want.filter((row) => containsAll(enc.encode(row.split("=")[1]!), patterns)));
          expect(await countOf(matchingStep(NO_ROWS, levels, patterns, marks, bounds, reverse))).toBe(matching.length);
        }
      }),
      { numRuns: 300 },
    );
    expect(passedOver).toBeGreaterThan(30);
  });
});

describe("the layers a view reads", () => {
  it("hands its marks to every level, so a scan passes over a run a range delete covers", async () => {
    const { paths, readers } = layout();
    const levels = runLevels(paths.map(levelOf), readers);
    const marks: Marks = [{ start: key(0), endExclusive: key(60), through: 1, at: 2 }];
    const bounds = { start: key(10), endExclusive: key(50) };
    for (const range of [bounds, { ...bounds, valueContains: [enc.encode("l1")] }]) {
      const seen: (Marks | undefined)[] = [];
      const spied = levels.map((level) =>
        Object.assign(Object.create(level) as RunLevel, {
          cursor: (b: ScanBounds | undefined, r: boolean, m?: Marks) => (seen.push(m), level.cursor(b, r, m)),
          scanContains: (p: readonly Uint8Array[], b: ScanBounds | undefined, r: boolean, m?: Marks) => (seen.push(m), level.scanContains(p, b, r, m)),
        }),
      );
      await entries(scanStep({ get: () => undefined, range: () => NO_ROWS }, spied, marks, range));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((m) => m === marks)).toBe(true);
    }
  });
});
