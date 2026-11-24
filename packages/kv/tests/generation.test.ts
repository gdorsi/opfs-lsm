import { crc32 } from "../src/store/crc32.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { __resetMemoryFsForTests, MemoryFs } from "../src/testing.js";
import { decodeGeneration, encodeGeneration, publishGeneration, publishL0 } from "../src/store/generation.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { encodeRunRef, encodeSstRef, sstBlockIndex, sstKeyRange, sstRunEnd } from "./oracle/sst-ref.js";
import { NO_MARKS } from "../src/store/marks.js";
import { NO_BLOCKS } from "./runs.js";
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

/** `buf` after `change`, with the CRC of the changed bytes: a manifest written on purpose. */
function rewritten(buf: Uint8Array, change: (view: DataView) => void): Uint8Array {
  const out = buf.slice();
  const view = new DataView(out.buffer);
  change(view);
  view.setUint32(out.byteLength - 4, crc32(out.subarray(0, out.byteLength - 4)), true);
  return out;
}

describe("manifest", () => {
  it("round-trips each run's size, key range, marksThrough and block index, and the marks", () => {
    const blocks = encodeSstRef(indexWorkload(300), 256);
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", ...sstRunEnd(blocks), marksThrough: 9 },
        { path: "l1/c2.0.sst", bytes: 2 ** 32 - 1, marksThrough: 0, index: NO_BLOCKS },
        // Separators of no byte and of many, and block sizes of one to five varint bytes.
        {
          path: "l2/c9.1.sst",
          bytes: 2 ** 32 - 1,
          range: { smallest: new Uint8Array(0), largest: new Uint8Array(300).fill(7) },
          marksThrough: 5,
          index: {
            sepBytes: new Uint8Array(300).fill(7),
            sepEnd: Uint32Array.of(0, 1, 1, 300, 300),
            blockStart: Uint32Array.of(0, 5, 5 + 2 ** 7, 5 + 2 ** 15, 5 + 2 ** 22, 2 ** 32 - 41),
          },
        },
      ],
      through: 9,
      marks: [{ start: utf("c"), endExclusive: utf("d"), through: 6, at: 7 }],
    };
    expect(meta.runs[0]!.index!.sepEnd.length).toBeGreaterThan(100);
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });

  it("stores a block of a run in four bytes and its separator", () => {
    const { index } = sstRunEnd(encodeSstRef(indexWorkload(2_000)));
    const size = (runIndex: typeof index) =>
      encodeGeneration({ generation: 1, runs: [{ path: "l0/1-1.sst", bytes: 2 ** 31, marksThrough: 0, index: runIndex }], through: 0, marks: NO_MARKS }).byteLength;
    expect(index.sepEnd.length).toBeGreaterThan(10);
    expect(size(index) - size(NO_BLOCKS)).toBeLessThanOrEqual(index.sepBytes.byteLength + 4 * index.sepEnd.length);
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

  it("refuses a block index that its bytes or its run cannot hold, whatever the CRC says", () => {
    const index = { sepBytes: utf("ab"), sepEnd: Uint32Array.of(1, 2), blockStart: Uint32Array.of(0, 100, 200) };
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst", bytes: 200, marksThrough: 7, index }], through: 7, marks: NO_MARKS };
    const valid = encodeGeneration(meta);
    expect(decodeGeneration(valid)).toEqual(meta);
    // The index ends the manifest: a u32 block count, a separator length and a block size for each block, one byte each here, the two separator bytes, then the CRC.
    const count = valid.byteLength - 14;
    const changes: [string, (view: DataView) => void][] = [
      ["more blocks than the bytes left could hold", (view) => view.setUint32(count, 0xffffffff, true)],
      ["one block more than it holds", (view) => view.setUint32(count, 3, true)],
      ["a separator longer than the bytes left", (view) => view.setUint8(count + 6, 2)],
      ["a block that ends past the run", (view) => view.setUint8(count + 7, 101)],
      ["a length of more than five bytes", (view) => [4, 5, 6, 7, 8].forEach((i) => view.setUint8(count + i, 0xff))],
    ];
    for (const [what, change] of changes) expect(() => decodeGeneration(rewritten(valid, change)), `with ${what}`).toThrow(CorruptDatabaseError);
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
    expect(run.index).toEqual(sstBlockIndex(file));
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
