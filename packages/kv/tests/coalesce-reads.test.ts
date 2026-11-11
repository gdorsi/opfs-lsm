import { describe, expect, it } from "vitest";
import { coalesceReads } from "../src/opfs/coalesce-reads.js";

const KiB = 1024;
const MiB = 1024 * KiB;

/** A file whose byte at `i` is `i % 251`, and the spans read from it. */
function file(failAt?: number) {
  const spans: [offset: number, length: number][] = [];
  const read = coalesceReads(async (offset, length) => {
    spans.push([offset, length]);
    if (failAt !== undefined && offset <= failAt && failAt < offset + length) throw new Error("disk");
    return Uint8Array.from({ length }, (_, i) => (offset + i) % 251).buffer;
  });
  return { spans, read };
}

const bytesAt = (offset: number, length: number) => Uint8Array.from({ length }, (_, i) => (offset + i) % 251);

describe("coalesceReads", () => {
  it("serves neighbouring reads of one task with one span", async () => {
    const f = file();
    const got = await Promise.all([f.read(64 * KiB, 32 * KiB), f.read(0, 32 * KiB), f.read(32 * KiB, 32 * KiB)]);
    expect(f.spans).toEqual([[0, 96 * KiB]]);
    expect(got[0]).toEqual(bytesAt(64 * KiB, 32 * KiB));
    expect(got[1]).toEqual(bytesAt(0, 32 * KiB));
    expect(got[2]).toEqual(bytesAt(32 * KiB, 32 * KiB));
  });

  it("reads through a small gap and returns only the bytes asked for", async () => {
    const f = file();
    const [a, b] = await Promise.all([f.read(0, 100), f.read(40 * KiB, 100)]);
    expect(f.spans).toEqual([[0, 40 * KiB + 100]]);
    expect(a).toEqual(bytesAt(0, 100));
    expect(b).toEqual(bytesAt(40 * KiB, 100));
  });

  it("reads far-apart ranges separately", async () => {
    const f = file();
    await Promise.all([f.read(0, 100), f.read(10 * MiB, 100)]);
    expect(f.spans).toEqual([[0, 100], [10 * MiB, 100]]);
  });

  it("splits a long run of pages so that no span passes 1 MiB", async () => {
    const f = file();
    const pages = Array.from({ length: 96 }, (_, p) => p * 32 * KiB);
    const got = await Promise.all(pages.map((at) => f.read(at, 32 * KiB)));
    expect(f.spans.length).toBeGreaterThan(1);
    for (const [, length] of f.spans) expect(length).toBeLessThanOrEqual(MiB);
    expect(f.spans.reduce((sum, [, length]) => sum + length, 0)).toBe(96 * 32 * KiB);
    got.forEach((bytes, p) => expect(bytes).toEqual(bytesAt(pages[p]!, 32 * KiB)));
  });

  it("reads a range larger than 1 MiB whole", async () => {
    const f = file();
    expect((await f.read(5, 3 * MiB)).byteLength).toBe(3 * MiB);
    expect(f.spans).toEqual([[5, 3 * MiB]]);
  });

  it("joins reads that callers issue after waking on the same promise", async () => {
    const f = file();
    const woke = Promise.resolve();
    const caller = async (at: number) => {
      await woke;
      await null;
      return f.read(at, 100);
    };
    await Promise.all([caller(0), caller(100), caller(200)]);
    expect(f.spans).toEqual([[0, 300]]);
  });

  it("starts a new batch for a read issued after the previous one landed", async () => {
    const f = file();
    await f.read(0, 100);
    await f.read(100, 100);
    expect(f.spans).toEqual([[0, 100], [100, 100]]);
  });

  it("gives each read its own buffer", async () => {
    const f = file();
    const [a, b] = await Promise.all([f.read(0, 100), f.read(0, 100)]);
    a![0] = 255;
    expect(b![0]).toBe(0);
    expect(a!.buffer.byteLength).toBe(100);
  });

  it("rejects the reads of a failed span and no others", async () => {
    const f = file(10 * MiB);
    const settled = await Promise.allSettled([f.read(0, 100), f.read(10 * MiB, 100), f.read(10 * MiB + 100, 100)]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "rejected"]);
  });
});
