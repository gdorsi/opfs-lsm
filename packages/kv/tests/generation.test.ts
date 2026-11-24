import { crc32 } from "../src/store/crc32.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { __resetMemoryFsForTests, MemoryFs } from "../src/testing.js";
import { decodeGeneration, encodeGeneration, manifestHead, publishGeneration, publishL0, runsOfCopy } from "../src/store/generation.js";
import { PageCache } from "../src/store/page-cache.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";
import { decodeIndex, encodeIndex, readFooter } from "../src/store/sst.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { encodeRunRef, encodeSstRef, indexBlob, sstBlockIndex, sstKeyRange, sstRunEnd } from "./oracle/sst-ref.js";
import { NO_MARKS } from "../src/store/marks.js";
import { NO_BLOCKS, runGet } from "./runs.js";
import { indexWorkload } from "./sst-workloads.js";

const NAME = "generation-coherence";
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

function mft(generation: number): string {
  return `m/${String(generation).padStart(16, "0")}.mft`;
}

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

/** `buf` with the CRC of the bytes before its last four. */
function sealed(buf: Uint8Array): Uint8Array {
  const end = buf.byteLength - 4;
  new DataView(buf.buffer).setUint32(end, crc32(buf.subarray(0, end)), true);
  return buf;
}

/** `buf` after `change`, with the CRC of its changed head: a manifest written on purpose. */
function rewritten(buf: Uint8Array, change: (view: DataView) => void): Uint8Array {
  const out = buf.slice();
  const view = new DataView(out.buffer);
  change(view);
  sealed(out.subarray(0, view.getUint32(24, true)));
  return out;
}

describe("manifest", () => {
  it("round-trips each run's size, key range, marksThrough and block index, and the marks", () => {
    const blocks = encodeSstRef(indexWorkload(300), 256);
    // Separators of no byte and of many, and block sizes of one to five varint bytes.
    const edges = {
      sepBytes: new Uint8Array(300).fill(7),
      sepEnd: Uint32Array.of(0, 1, 1, 300, 300),
      blockStart: Uint32Array.of(0, 5, 5 + 2 ** 7, 5 + 2 ** 15, 5 + 2 ** 22, 2 ** 32 - 41),
    };
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", ...sstRunEnd(blocks), marksThrough: 9 },
        { path: "l1/c2.0.sst", bytes: 2 ** 32 - 1, marksThrough: 0, index: NO_BLOCKS },
        {
          path: "l2/c9.1.sst",
          bytes: 2 ** 32 - 1,
          range: { smallest: new Uint8Array(0), largest: new Uint8Array(300).fill(7) },
          marksThrough: 5,
          index: indexBlob(edges),
        },
      ],
      through: 9,
      marks: [{ start: utf("c"), endExclusive: utf("d"), through: 6, at: 7 }],
    };
    expect(sstBlockIndex(blocks).sepEnd.length).toBeGreaterThan(100);
    const back = decodeGeneration(encodeGeneration(meta));
    expect(back).toEqual(meta);
    expect(back.runs.map((r) => decodeIndex(r.index, r.bytes))).toEqual([sstBlockIndex(blocks), decodeIndex(NO_BLOCKS, 0), edges]);
  });

  it("stores a block of a run in four bytes and its separator", () => {
    const body = encodeSstRef(indexWorkload(2_000));
    const index = sstBlockIndex(body);
    expect(index.sepEnd.length).toBeGreaterThan(10);
    expect(sstRunEnd(body).index.byteLength - NO_BLOCKS.byteLength).toBeLessThanOrEqual(index.sepBytes.byteLength + 4 * index.sepEnd.length);
  });

  it("refuses marks or a run that reach past the manifest's through", () => {
    const valid = { generation: 2, runs: [], through: 7, marks: NO_MARKS };
    const late = [{ start: utf("c"), through: 6, at: 8 }];
    const run = { path: "l0/1-1.sst", bytes: 90, marksThrough: 8, index: NO_BLOCKS };
    for (const meta of [{ ...valid, marks: late }, { ...valid, runs: [run] }]) {
      expect(() => decodeGeneration(encodeGeneration(meta))).toThrow(CorruptDatabaseError);
    }
  });

  it.each([1, 2, 3, 4, 5])("refuses a version %i manifest rather than read it as version 6", (version) => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst", bytes: 90, marksThrough: 7, index: NO_BLOCKS }], through: 7, marks: NO_MARKS };
    const buf = rewritten(encodeGeneration(meta), (view) => view.setUint32(4, version, true));
    expect(() => decodeGeneration(buf)).toThrow(CorruptDatabaseError);
    expect(() => decodeGeneration(buf)).toThrow("bad generation version");
  });

  describe("a run's block index", () => {
    const index = { sepBytes: utf("ab"), sepEnd: Uint32Array.of(1, 2), blockStart: Uint32Array.of(0, 100, 200) };
    const valid = indexBlob(index);
    // A u32 block count, a separator length and a block size for each block, one byte each here, the two separator bytes, then the CRC.
    const changes: [string, (blob: Uint8Array) => Uint8Array][] = [
      ["more blocks than the bytes left could hold", (b) => (new DataView(b.buffer).setUint32(0, 0xffffffff, true), b)],
      ["one block more than it holds", (b) => (new DataView(b.buffer).setUint32(0, 3, true), b)],
      ["a separator longer than the bytes left", (b) => ((b[6] = 2), b)],
      ["a block that ends past the run", (b) => ((b[7] = 101), b)],
      ["a length of more than five bytes", (b) => (b.fill(0xff, 4, 9), b)],
      ["bytes after the separators", (b) => Uint8Array.of(...b.subarray(0, -4), 0, 0, 0, 0, 0)],
    ];

    it("decodes to the index it was written from", () => {
      expect(decodeIndex(valid, 200)).toEqual(index);
    });

    it.each(changes)("is refused with %s, under a CRC of those bytes", (_, change) => {
      expect(() => decodeIndex(sealed(change(valid.slice())), 200)).toThrow("sst index");
    });

    it("is refused when it is too short to hold a count", () => {
      expect(() => decodeIndex(sealed(new Uint8Array(7)), 200)).toThrow(CorruptDatabaseError);
    });

    it("is refused when a byte changed under its CRC", () => {
      for (let i = 0; i < valid.length; i++) {
        const changed = valid.slice();
        changed[i]! ^= 1;
        expect(() => decodeIndex(changed, 200)).toThrow("sst index");
      }
    });

    it("is not read by the manifest: a malformed one fails the first read of its run, and no other", async () => {
      const bad = new Uint8Array(valid.length);
      new DataView(bad.buffer).setUint32(0, 0xffffffff, true);
      const body = encodeSstRef([{ kind: "put", key: utf("k"), value: utf("v"), seq: 1 }]);
      const good = { path: "l0/1-1.sst", ...sstRunEnd(body), marksThrough: 1 };
      const meta = { generation: 2, runs: [{ ...good, path: "l0/2-2.sst", index: bad }, good], through: 1, marks: NO_MARKS };
      const runs = decodeGeneration(encodeGeneration(meta)).runs.map((r) => new SstReader(bytesFile(body), new PageCache(), r));
      expect(() => runs[0]!.get(utf("k"))).toThrow(CorruptDatabaseError);
      expect(() => runs[0]!.cursor()).toThrow(CorruptDatabaseError);
      expect((await runGet(runs[1]!, utf("k")))?.seq).toBe(1);
    });

    it("is encoded from the index rows of a run's file as its decoded index says", () => {
      const body = encodeSstRef(indexWorkload(300), 256);
      const { indexStart, indexEnd } = readFooter(body, body.byteLength);
      expect(encodeIndex(body.subarray(indexStart, indexEnd))).toEqual(indexBlob(sstBlockIndex(body)));
    });
  });
});

describe("a manifest's head", () => {
  const body = encodeSstRef(indexWorkload(300), 256);
  const meta = {
    generation: 4,
    runs: [
      { path: "l0/3-4.sst", ...sstRunEnd(body), marksThrough: 4 },
      { path: "l1/c2.0.sst", ...sstRunEnd(body), marksThrough: 2 },
    ],
    through: 4,
    marks: NO_MARKS,
  };
  const file = encodeGeneration(meta);
  const head = manifestHead(file);

  it("names the runs and holds no block index, in a buffer of its own", () => {
    expect(runsOfCopy(head, 4)).toEqual(["l0/3-4.sst", "l1/c2.0.sst"]);
    expect(head.byteLength).toBe(file.byteLength - 2 * sstRunEnd(body).index.byteLength);
    expect(head.buffer.byteLength).toBe(head.byteLength);
    expect(file.subarray(0, head.byteLength)).toEqual(head);
  });

  it("is what publishGeneration returns for the transaction that records the manifest", async () => {
    const fs = new MemoryFs();
    expect(await publishGeneration(fs, meta)).toEqual(head);
    expect(await fs.read(mft(4), 0, Number.POSITIVE_INFINITY)).toEqual(file);
  });

  it("names no runs for another generation, or when it does not decode", () => {
    expect(runsOfCopy(head, 5)).toBeUndefined();
    expect(runsOfCopy(undefined, 4)).toBeUndefined();
    expect(runsOfCopy(head.subarray(0, -1), 4)).toBeUndefined();
    const changed = head.slice();
    changed[30]! ^= 1;
    expect(runsOfCopy(changed, 4)).toBeUndefined();
  });

  it("is not a manifest file: the indexes it leaves out, a file cut short and bytes after the last index are refused", () => {
    for (const buf of [head, file.subarray(0, -1), Uint8Array.of(...file, 0)]) {
      expect(() => decodeGeneration(buf)).toThrow("generation trailing");
    }
  });
});

describe("publishL0", () => {
  it("returns the size, key range and block index of the file it wrote", async () => {
    const fs = new MemoryFs();
    const entries = Array.from({ length: 500 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(4, "0")}`),
      value: utf(`value ${i}`),
      seq: i + 1,
    }));
    const run = await publishL0(fs, "1-500", entries, 500);
    const file = (await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!;
    expect(run.path).toBe("l0/1-500.sst");
    expect(run.bytes).toBe(file.byteLength);
    expect(run.range).toEqual(sstKeyRange(file));
    expect(run.index).toEqual(indexBlob(sstBlockIndex(file)));
    expect(file).toEqual(encodeRunRef(entries).body);
  });

  it("gives an empty run no key range, and its size", async () => {
    const fs = new MemoryFs();
    const run = await publishL0(fs, "0-0", [], 0);
    expect(run.range).toBeUndefined();
    expect(run.bytes).toBe((await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!.byteLength);
  });
});

describe("loadLatestGeneration", () => {
  const a = { path: "l0/a.sst", bytes: 1, marksThrough: 0, index: NO_BLOCKS };

  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], through: 0, marks: NO_MARKS });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], through: 0, marks: NO_MARKS });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], through: 0, marks: NO_MARKS });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], through: 0, marks: NO_MARKS });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });

  it("returns the newest manifest when it is larger than 1 MiB", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], through: 0, marks: NO_MARKS });
    const key = (c: number) => new Uint8Array(8 * 1024).fill(c);
    const runs = Array.from({ length: 100 }, (_, i) => ({
      path: `l1/r${i}.sst`,
      bytes: 4_194_304,
      range: { smallest: key(i * 2), largest: key(i * 2 + 1) },
      marksThrough: 0,
      index: NO_BLOCKS,
    }));
    await publishGeneration(fs, { generation: 2, runs, through: 0, marks: NO_MARKS });
    const meta = await loadLatestGeneration(fs);
    expect(meta?.generation).toBe(2);
    expect(meta?.runs).toHaveLength(100);
  });
});
