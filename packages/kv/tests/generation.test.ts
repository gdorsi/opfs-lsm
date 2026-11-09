import { crc32 } from "../src/store/crc32.js";
import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/index.js";
import {
  decodeGeneration,
  encodeGeneration,
  loadLatestGeneration,
  publishGeneration,
} from "../src/store/generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

function mft(generation: number): string {
  return `m/${String(generation).padStart(16, "0")}.mft`;
}

/** `v3` re-encoded as an older version: the u64 fields at [from, to) cut out. */
function olderVersion(v3: Uint8Array, version: number, from: number, to: number): Uint8Array {
  const out = new Uint8Array(v3.byteLength - (to - from));
  out.set(v3.subarray(0, from));
  out.set(v3.subarray(to, v3.byteLength - 4), from);
  const view = new DataView(out.buffer);
  view.setUint32(4, version, true);
  view.setUint32(out.byteLength - 4, crc32(out.subarray(0, out.byteLength - 4)), true);
  return out;
}

describe("manifest", () => {
  it("round-trips each run's key range", () => {
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", range: { smallest: utf("a"), largest: utf("m") } },
        { path: "l1/c2.0-10.sst" },
      ],
      tombstoneSeq: 4,
      through: 9,
      cut: 123_456_789_012,
    };
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });

  it("reads a version 1 manifest, which has no through or cut, as 0", () => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst" }], tombstoneSeq: 1, through: 7, cut: 99 };
    // Version 1: the same fields without the u64 through and cut after tombstoneSeq.
    const v1 = olderVersion(encodeGeneration(meta), 1, 24, 40);
    expect(decodeGeneration(v1)).toEqual({ ...meta, through: 0, cut: 0 });
  });

  it("reads a version 2 manifest, which has no cut, as cut 0", () => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst" }], tombstoneSeq: 1, through: 7, cut: 99 };
    // Version 2: the same fields without the u64 cut after through.
    const v2 = olderVersion(encodeGeneration(meta), 2, 32, 40);
    expect(decodeGeneration(v2)).toEqual({ ...meta, cut: 0 });
  });
});

describe("loadLatestGeneration", () => {
  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0, through: 0, cut: 0 });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0, through: 0, cut: 0 });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0, through: 0, cut: 0 });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0, through: 0, cut: 0 });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });

  it("returns the newest manifest when it is larger than 1 MiB", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/a.sst" }], tombstoneSeq: 0, through: 0, cut: 0 });
    const key = (c: number) => new Uint8Array(8 * 1024).fill(c);
    const runs = Array.from({ length: 100 }, (_, i) => ({
      path: `l1/r${i}-4194304.sst`,
      range: { smallest: key(i * 2), largest: key(i * 2 + 1) },
    }));
    await publishGeneration(fs, { generation: 2, runs, tombstoneSeq: 0, through: 0, cut: 0 });
    const meta = await loadLatestGeneration(fs);
    expect(meta?.generation).toBe(2);
    expect(meta?.runs).toHaveLength(100);
  });
});
