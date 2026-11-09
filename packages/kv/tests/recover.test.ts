import { afterEach, describe, expect, it } from "vitest";
import { checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { EngineHost, MemoryFs, createLocalIngestClient, type Db } from "../src/index.js";
import { KIND_RECORD, encodeFrame, encodeOps, segmentPath, type Stamp } from "../src/log/frame.js";
import { recoverGeneration } from "../src/recover.js";
import {
  GENERATION_ZERO,
  loadLatestGeneration,
  publishGeneration,
  publishRun,
  type GenerationMeta,
} from "../src/store/generation.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

/**
 * `recoverGeneration` (design.md, "Recovery"): the newest intact manifest
 * is the committed generation. A power loss can leave the newest manifest
 * empty or listing a run that never reached the disk; an older one stands
 * in only while the logs still hold every record above its cut. The crash
 * enumeration in tests/sim/crash-enum.test.ts checks every crash state;
 * these pin each branch.
 */
const enc = new TextEncoder();
const trustAll = () => true;
const trustNone = () => false;
const TAB = "00000000000000aa";

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode(`k${i}`)), value: checkValue(enc.encode(`v${i}`)) }];
}

/** A manifest with one (fake) non-empty run per name. */
async function manifest(
  fs: MemoryFs,
  generation: number,
  through: number,
  cut: Stamp,
  runs: string[],
): Promise<GenerationMeta> {
  for (const path of runs) await publishRun(fs, path, new Uint8Array([1]));
  const meta = { generation, runs: runs.map((path) => ({ path })), tombstoneSeq: 0, through, cut };
  await publishGeneration(fs, meta);
  return meta;
}

/**
 * One log segment of TAB holding a record per stamp, after `prevStamp`:
 * 0 for the tab's first segment, the last reclaimed record's stamp otherwise.
 */
async function segment(fs: MemoryFs, prevStamp: Stamp, stamps: Stamp[]): Promise<void> {
  const firstN = prevStamp === 0 ? 1 : 100;
  const w = await fs.create(segmentPath(TAB, { firstN, prevStamp }));
  for (const [i, stamp] of stamps.entries()) {
    await w.write(encodeFrame(KIND_RECORD, stamp, firstN + i, encodeOps(put(i))));
  }
  await w.finish();
}

/** Flip one byte of the newest manifest, as a disk fault would and a power loss cannot. */
async function flipNewest(fs: MemoryFs): Promise<void> {
  const path = "m/" + [...(await fs.list("m"))].sort().at(-1)!;
  const buf = (await fs.read(path, 0, Number.POSITIVE_INFINITY))!.slice();
  buf[buf.byteLength >> 1]! ^= 0xff;
  const w = await fs.create(path);
  await w.write(buf);
  await w.finish();
}

async function emptyManifest(fs: MemoryFs, generation: number): Promise<void> {
  const w = await fs.create(`m/${String(generation).padStart(16, "0")}.mft`);
  await w.finish();
}

describe("recoverGeneration", () => {
  it("is generation 0 on a new database", async () => {
    expect(await recoverGeneration(new MemoryFs(), trustNone)).toEqual({ meta: GENERATION_ZERO, top: 0 });
  });

  it("picks the newest intact manifest", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    const newest = await manifest(fs, 2, 2, 20, ["l0/2-2.sst", "l0/1-1.sst"]);
    expect(await recoverGeneration(fs, trustNone)).toEqual({ meta: newest, top: 2 });
  });

  it("skips an empty newest manifest, and never reuses its number", async () => {
    // A power loss after creating manifest 2 and before closing it.
    const fs = new MemoryFs();
    const kept = await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    await emptyManifest(fs, 2);
    expect(await recoverGeneration(fs, trustNone)).toEqual({ meta: kept, top: 2 });
  });

  it("refuses a newest manifest that does not decode", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    await manifest(fs, 2, 2, 20, ["l0/1-1.sst", "l0/2-2.sst"]);
    await flipNewest(fs);
    await expect(recoverGeneration(fs, trustAll)).rejects.toThrow(CorruptDatabaseError);
  });

  it("refuses a manifest that does not decode between a broken newest one and an intact older one", async () => {
    // Manifest 3 lost its run, manifest 2 is corrupt, manifest 1 is intact.
    // Manifest 2 may hold the newest state, so recovery stops there.
    const fs = new MemoryFs();
    await segment(fs, 0, [5, 15, 25]);
    await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    await manifest(fs, 2, 2, 20, ["l0/1-1.sst", "l0/2-2.sst"]);
    await flipNewest(fs);
    const broken = await manifest(fs, 3, 3, 30, ["l0/3-3.sst", "l0/1-1.sst", "l0/2-2.sst"]);
    await fs.remove(broken.runs[0]!.path);
    await expect(recoverGeneration(fs, trustNone)).rejects.toThrow(CorruptDatabaseError);
  });

  it("falls back from a manifest whose run is gone while the logs hold every record above the older cut", async () => {
    const fs = new MemoryFs();
    // Nothing reclaimed: the log still starts at the tab's first record.
    await segment(fs, 0, [5, 15, 25]);
    const older = await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    const broken = await manifest(fs, 2, 2, 20, ["l0/2-2.sst", "l0/1-1.sst"]);
    await fs.remove(broken.runs[0]!.path);
    expect(await recoverGeneration(fs, trustNone)).toEqual({ meta: older, top: 2 });
  });

  it("refuses to fall back when the logs no longer hold the records above the older cut", async () => {
    const fs = new MemoryFs();
    // Reclaim removed the segment through stamp 15, which manifest 2 covered.
    await segment(fs, 15, [25]);
    await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    const broken = await manifest(fs, 2, 2, 20, ["l0/2-2.sst", "l0/1-1.sst"]);
    await fs.remove(broken.runs[0]!.path);
    await expect(recoverGeneration(fs, trustNone)).rejects.toThrow(CorruptDatabaseError);
  });

  it("falls back to generation 0 only while the logs hold every record", async () => {
    const whole = new MemoryFs();
    await segment(whole, 0, [5, 15]);
    const broken = await manifest(whole, 1, 1, 10, ["l0/1-1.sst"]);
    await whole.remove(broken.runs[0]!.path);
    expect(await recoverGeneration(whole, trustNone)).toEqual({ meta: GENERATION_ZERO, top: 1 });

    const reclaimed = new MemoryFs();
    await segment(reclaimed, 5, [15]);
    const gone = await manifest(reclaimed, 1, 1, 10, ["l0/1-1.sst"]);
    await reclaimed.remove(gone.runs[0]!.path);
    await expect(recoverGeneration(reclaimed, trustNone)).rejects.toThrow(CorruptDatabaseError);
  });

  it("does not check the runs of a trusted generation", async () => {
    const fs = new MemoryFs();
    await segment(fs, 0, [5, 15]);
    await manifest(fs, 1, 1, 10, ["l0/1-1.sst"]);
    const newest = await manifest(fs, 2, 2, 20, ["l0/2-2.sst", "l0/1-1.sst"]);
    await fs.remove(newest.runs[0]!.path);
    expect((await recoverGeneration(fs, (g) => g === 2)).meta).toEqual(newest);
    expect((await recoverGeneration(fs, trustNone)).meta.generation).toBe(1);
  });
});

/**
 * End to end: a power loss kept the newest manifest and lost its L0 run.
 * The open falls back to the older manifest and reads the rest from the logs.
 */
describe("a lost run", () => {
  const NAME = "recover-lost-run";
  const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
  const opened: Db[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
    __resetMemoryFsForTests(NAME);
  });

  // Skipped: open trusts every manifest (`recoverGeneration(tabFs, () => true)`
  // in db.ts), so it never falls back and throws "SST files for the committed
  // generation stayed missing after retries". Unskip once open falls back.
  it("reopens to every acked write through the older manifest and the logs", async () => {
    const fs = new MemoryFs();
    const open = async () => {
      const db = await openHarnessDb({
        name: NAME,
        fs,
        ingest: createLocalIngestClient(new EngineHost(() => fs)),
        ingestPolicy: { maxWalBytes: 1 << 30 },
      });
      opened.push(db);
      return db;
    };
    const db = await open();
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.ingest();
    await db.put(enc.encode("b"), enc.encode("2"));
    await db.ingest();
    await db.put(enc.encode("c"), enc.encode("3"));
    await db.close();

    const newest = (await loadLatestGeneration(fs))!;
    expect(newest.through).toBe(2);
    await fs.remove(newest.runs[0]!.path);

    const reopened = await open();
    expect(text(await reopened.get(enc.encode("a")))).toBe("1");
    expect(text(await reopened.get(enc.encode("b")))).toBe("2");
    expect(text(await reopened.get(enc.encode("c")))).toBe("3");
    // The next ingest numbers past the lost manifest and folds what it held again.
    await reopened.put(enc.encode("d"), enc.encode("4"));
    const { generation } = await reopened.ingest();
    expect(generation).toBeGreaterThan(newest.generation);
    expect((await loadLatestGeneration(fs))!.through).toBe(4);
    expect(text(await reopened.get(enc.encode("b")))).toBe("2");
    expect(text(await reopened.get(enc.encode("d")))).toBe("4");
  });
});
