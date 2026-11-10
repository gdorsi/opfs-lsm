import { crc32 } from "../src/store/crc32.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import {
  MemoryFs
} from "../src/index.js";
import {
  __resetMemoryFsForTests
} from "../src/testing.js";
import {
  decodeGeneration,
  encodeGeneration,
  loadLatestGeneration,
  publishGeneration,
  publishL0,
} from "../src/store/generation.js";
import { encodeRun, sstKeyRange } from "../src/store/sst.js";
import { checkDbName } from "../src/check.js";
import { installStep } from "../src/host/compact.js";
import type { LogId, QueueCursor } from "../src/host/queues.js";
import { IdBWal } from "../src/idb/wal.js";
import { loadGeneration, publishRun } from "../src/store/generation.js";

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
  it("round-trips each run's size and key range", () => {
    const meta = {
      generation: 3,
      runs: [
        { path: "l0/1-2.sst", bytes: 4_321, range: { smallest: utf("a"), largest: utf("m") } },
        { path: "l1/c2.0.sst", bytes: 2 ** 32 - 1 },
        { path: "l2/c9.1.sst", bytes: 0, range: { smallest: new Uint8Array(0), largest: new Uint8Array(0) } },
      ],
      tombstoneSeq: 4,
      through: 9,
    };
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });

  const queues: QueueCursor[] = [
    { log: "00000000000000a1" as LogId, state: "open", n: 7 },
    { log: "00000000000000b2" as LogId, state: "final", n: 0 },
    { log: "00000000000000c3" as LogId, state: "damaged", n: 2 ** 32 - 1, reason: "bad frame é" },
  ];

  it("round-trips the queue cursors", () => {
    const meta = { generation: 5, runs: [{ path: "l0/1-3.sst", bytes: 10 }], tombstoneSeq: 0, through: 3, queues };
    expect(decodeGeneration(encodeGeneration(meta))).toEqual(meta);
  });

  it("reads a version 3 manifest, which has no cursors, as a manifest with none", () => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst", bytes: 90 }], tombstoneSeq: 1, through: 7 };
    const v4 = encodeGeneration(meta);
    const v3 = new Uint8Array(v4.byteLength - 4);
    v3.set(v4.subarray(0, v3.byteLength - 4));
    new DataView(v3.buffer).setUint32(4, 3, true);
    new DataView(v3.buffer).setUint32(v3.byteLength - 4, crc32(v3.subarray(0, v3.byteLength - 4)), true);
    const got = decodeGeneration(v3);
    expect(got).toEqual(meta);
    expect(got.queues).toBeUndefined();
  });

  it("refuses a cursor state it does not know", () => {
    const buf = encodeGeneration({ generation: 1, runs: [], tombstoneSeq: 0, through: 0, queues: [queues[0]!] });
    buf[40] = 3;
    new DataView(buf.buffer).setUint32(buf.byteLength - 4, crc32(buf.subarray(0, buf.byteLength - 4)), true);
    expect(() => decodeGeneration(buf)).toThrow(CorruptDatabaseError);
  });

  it("keeps the base's cursors through a compaction install", async () => {
    const fs = new MemoryFs();
    const wal = await IdBWal.open(checkDbName(NAME));
    try {
      await publishRun(fs, "l0/1-3.sst", new Uint8Array([1]));
      await publishGeneration(fs, { generation: 1, runs: [{ path: "l0/1-3.sst", bytes: 1 }], tombstoneSeq: 0, through: 3, queues });
      const generation = await installStep(fs, wal, { inputs: ["l0/1-3.sst"], outputs: [{ path: "l1/c2.0.sst", bytes: 1 }], droppedSeq: 0 });
      expect(generation).toBe(2);
      expect((await loadGeneration(fs, 2))?.queues).toEqual(queues);
    } finally {
      wal.close();
    }
  });

  it.each([1, 2])("refuses a version %i manifest, which has no run sizes, rather than read it as version 3", (version) => {
    const meta = { generation: 2, runs: [{ path: "l0/1-1.sst", bytes: 90 }], tombstoneSeq: 1, through: 7 };
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
    const run = await publishL0(fs, "1-500", entries);
    const file = (await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!;
    expect(run.path).toBe("l0/1-500.sst");
    expect(run.bytes).toBe(file.byteLength);
    expect(run.range).toEqual(sstKeyRange(file));
    expect(file).toEqual(encodeRun(entries).body);
  });

  it("gives an empty run no key range, and its size", async () => {
    const fs = new MemoryFs();
    const run = await publishL0(fs, "0-0", []);
    expect(run.range).toBeUndefined();
    expect(run.bytes).toBe((await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!.byteLength);
  });
});

describe("loadLatestGeneration", () => {
  const a = { path: "l0/a.sst", bytes: 1 };

  it("skips an empty newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0 });
    const empty = await fs.create(mft(2));
    await empty.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], tombstoneSeq: 0, through: 0 });
  });

  it("skips an undecodable newest manifest and returns the older one", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0 });
    const torn = await fs.create(mft(2));
    await torn.write(new Uint8Array([1, 2, 3, 4]));
    await torn.finish();

    const meta = await loadLatestGeneration(fs);
    expect(meta).toEqual({ generation: 1, runs: [a], tombstoneSeq: 0, through: 0 });
  });

  it("returns undefined when every manifest is empty", async () => {
    const fs = new MemoryFs();
    const empty = await fs.create(mft(1));
    await empty.finish();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
  });

  it("returns the newest manifest when it is larger than 1 MiB", async () => {
    const fs = new MemoryFs();
    await publishGeneration(fs, { generation: 1, runs: [a], tombstoneSeq: 0, through: 0 });
    const key = (c: number) => new Uint8Array(8 * 1024).fill(c);
    const runs = Array.from({ length: 100 }, (_, i) => ({
      path: `l1/r${i}.sst`,
      bytes: 4_194_304,
      range: { smallest: key(i * 2), largest: key(i * 2 + 1) },
    }));
    await publishGeneration(fs, { generation: 2, runs, tombstoneSeq: 0, through: 0 });
    const meta = await loadLatestGeneration(fs);
    expect(meta?.generation).toBe(2);
    expect(meta?.runs).toHaveLength(100);
  });
});
