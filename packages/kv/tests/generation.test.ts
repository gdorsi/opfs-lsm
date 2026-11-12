import { crc32 } from "../src/store/crc32.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { __resetMemoryFsForTests, MemoryFs } from "../src/testing.js";
import {
  decodeGeneration,
  encodeGeneration,
  loadLatestGeneration,
  publishGeneration,
  publishL0,
} from "../src/store/generation.js";
import { encodeRun, sstKeyRange } from "../src/store/sst.js";
import { markTable, NO_MARKS } from "../src/store/marks.js";

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

describe("manifest", () => {
  it("round-trips each run's size, key range and marksThrough, and the marks", () => {
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", bytes: 4_321, range: { smallest: utf("a"), largest: utf("m") }, marksThrough: 9 },
        { path: "l1/c2.0.sst", bytes: 2 ** 32 - 1, marksThrough: 0 },
        { path: "l2/c9.1.sst", bytes: 0, range: { smallest: new Uint8Array(0), largest: new Uint8Array(0) }, marksThrough: 5 },
      ],
      tombstoneSeq: 4,
      through: 9,
      marks: markTable({ start: utf("c"), endExclusive: utf("d"), through: 6, at: 7 }),
    };
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });

  it("refuses marks or a run that reach past the manifest's through", () => {
    const valid = { generation: 2, runs: [], tombstoneSeq: 0, through: 7, marks: NO_MARKS };
    const late = markTable({ start: utf("c"), through: 6, at: 8 });
    const run = { path: "l0/1-1.sst", bytes: 90, marksThrough: 8 };
    for (const meta of [{ ...valid, marks: late }, { ...valid, runs: [run] }]) {
      expect(() => decodeGeneration(encodeGeneration(meta))).toThrow(CorruptDatabaseError);
    }
  });

  it.each([1, 2, 3])("refuses a version %i manifest, which has no marks, rather than read it as version 4", (version) => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst", bytes: 90, marksThrough: 7 }], tombstoneSeq: 1, through: 7, marks: NO_MARKS };
    const buf = encodeGeneration(meta);
    new DataView(buf.buffer).setUint32(4, version, true);
    new DataView(buf.buffer).setUint32(buf.byteLength - 4, crc32(buf.subarray(0, buf.byteLength - 4)), true);
    expect(() => decodeGeneration(buf)).toThrow(CorruptDatabaseError);
    expect(() => decodeGeneration(buf)).toThrow("bad generation version");
  });
});

describe("publishL0", () => {
  it("returns the size and key range of the file it wrote", async () => {
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
    expect(file).toEqual(encodeRun(entries).body);
  });

  it("gives an empty run no key range, and its size", async () => {
    const fs = new MemoryFs();
    const run = await publishL0(fs, "0-0", [], 0);
    expect(run.range).toBeUndefined();
    expect(run.bytes).toBe((await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!.byteLength);
  });
});

describe("loadLatestGeneration", () => {
  const a = { path: "l0/a.sst", bytes: 1, marksThrough: 0 };

  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0, marks: NO_MARKS });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], tombstoneSeq: 0, through: 0, marks: NO_MARKS });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0, marks: NO_MARKS });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], tombstoneSeq: 0, through: 0, marks: NO_MARKS });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });

  it("returns the newest manifest when it is larger than 1 MiB", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0, marks: NO_MARKS });
    const key = (c: number) => new Uint8Array(8 * 1024).fill(c);
    const runs = Array.from({ length: 100 }, (_, i) => ({
      path: `l1/r${i}.sst`,
      bytes: 4_194_304,
      range: { smallest: key(i * 2), largest: key(i * 2 + 1) },
      marksThrough: 0,
    }));
    await publishGeneration(fs, { generation: 2, runs, tombstoneSeq: 0, through: 0, marks: NO_MARKS });
    const meta = await loadLatestGeneration(fs);
    expect(meta?.generation).toBe(2);
    expect(meta?.runs).toHaveLength(100);
  });
});
