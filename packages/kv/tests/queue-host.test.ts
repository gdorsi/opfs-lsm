import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import type { LogId, QueueCursor } from "../src/host/queues.js";
import { segmentPath } from "../src/log/segment.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import { recoverQueues } from "../src/recover.js";
import { publishGeneration, publishRun } from "../src/store/generation.js";

const A = "00000000000000a1" as LogId;
const B = "00000000000000b2" as LogId;

async function file(fs: MemoryFs, path: string, bytes = new Uint8Array([1])): Promise<void> {
  await publishRun(fs, path, bytes);
}

async function manifest(fs: MemoryFs, generation: number, queues: QueueCursor[], runs: string[] = []): Promise<void> {
  for (const path of runs) await file(fs, path);
  await publishGeneration(fs, { generation, runs: runs.map((path) => ({ path, bytes: 1 })), tombstoneSeq: 0, through: 0, queues });
}

describe("recoverQueues", () => {
  it("builds on the newest manifest whose runs are all there, past an empty one and one whose run is gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }], ["l0/1-3.sst"]);
    await manifest(fs, 2, [{ log: A, state: "open", n: 5 }], ["l0/4-5.sst"]);
    await fs.remove("l0/4-5.sst");
    await file(fs, "m/0000000000000003.mft", new Uint8Array(0));
    await file(fs, segmentPath(A, 1));

    const got = await recoverQueues(fs);
    expect(got.base.generation).toBe(1);
    expect(got.base.queues).toEqual([{ log: A, state: "open", n: 3 }]);
    expect(got.top).toBe(3);
    expect(got.logs).toEqual([{ log: A, segments: [1] }]);
  });

  it("opens an empty database and one whose logs start at their first record", async () => {
    expect((await recoverQueues(new MemoryFs())).base.generation).toBe(0);
    const fs = new MemoryFs();
    await file(fs, segmentPath(A, 1));
    await file(fs, segmentPath(A, 9));
    expect((await recoverQueues(fs)).logs).toEqual([{ log: A, segments: [1, 9] }]);
  });

  it("refuses when an open cursor's log is gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }]);
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("refuses when a log's first segment starts past the record after its cursor", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }]);
    await file(fs, segmentPath(A, 6));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("refuses a log that starts past record 1 when no manifest has a cursor for it", async () => {
    const fs = new MemoryFs();
    await file(fs, segmentPath(B, 4));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("opens past a final log whose segments are gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "final", n: 8 }]);
    await file(fs, segmentPath(A, 7));
    expect((await recoverQueues(fs)).base.generation).toBe(1);
  });

  it("refuses a newest manifest that does not decode", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, []);
    await file(fs, "m/0000000000000002.mft", new Uint8Array([1, 2, 3, 4]));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });
});
