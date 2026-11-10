import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { MemoryFs } from "../src/index.js";
import { newestIntact } from "../src/recover.js";
import { crc32 } from "../src/store/crc32.js";
import { publishGeneration, publishRun, type GenerationMeta } from "../src/store/generation.js";
import { Host, openHarnessDb } from "../src/testing.js";

/**
 * `newestIntact` (design.md, "Recovery"): the manifest the host builds on.
 * After a power loss OPFS keeps some prefix of its writes, so the newest
 * manifests can be empty or list a run that is gone. Corruption is not a
 * power loss, and is refused. tests/sim/queue-crash-enum.test.ts checks
 * every crash state; these pin each branch.
 */
const enc = new TextEncoder();
let n = 0;
let name = "";

/** A manifest with one (fake) non-empty run per name. */
async function manifest(fs: MemoryFs, generation: number, through: number, runs: string[]): Promise<GenerationMeta> {
  for (const path of runs) await publishRun(fs, path, new Uint8Array([1]));
  const meta = { generation, runs: runs.map((path) => ({ path, bytes: 1 })), tombstoneSeq: 0, through };
  await publishGeneration(fs, meta);
  return meta;
}

/** Flip one byte of the newest manifest, as a disk fault would and a power loss cannot. */
async function flipByte(fs: MemoryFs): Promise<void> {
  const path = "m/" + (await fs.list("m")).sort().at(-1)!;
  const buf = (await fs.read(path, 0, Number.POSITIVE_INFINITY))!;
  buf[buf.byteLength >> 1]! ^= 0xff;
  const w = await fs.create(path);
  await w.write(buf);
  await w.finish();
}

describe("newestIntact", () => {
  it("is generation 0 on a new database", async () => {
    expect(await newestIntact(new MemoryFs())).toMatchObject({ base: { generation: 0 }, top: 0 });
  });

  it("skips a newer manifest whose run is gone, and numbers past it", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, 2, ["l0/1-2.sst"]);
    const broken = await manifest(fs, 2, 5, ["l0/3-5.sst", "l0/1-2.sst"]);
    await fs.remove(broken.runs[0]!.path);
    expect(await newestIntact(fs)).toMatchObject({ base: { generation: 1 }, top: 2 });
  });

  it("refuses a manifest that does not decode, even with an intact one below it", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, ["l0/1-1.sst"]);
    await manifest(fs, 2, 2, ["l0/1-1.sst", "l0/2-2.sst"]);
    await flipByte(fs);
    await expect(newestIntact(fs)).rejects.toThrow(CorruptDatabaseError);
  });
});

/**
 * Manifest version 3 added each run's byte size, and nothing reads versions 1
 * or 2. A database from before it fails to open and keeps its files.
 */
describe("a database written before manifests held run sizes", () => {
  it("is refused at open and left as it was", async () => {
    name = `recover-${++n}`;
    const fs = new MemoryFs();
    const open = () => openHarnessDb({ name, fs, host: new Host(() => fs) });
    const db = await open();
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.ingest();
    await db.close();

    const path = `m/${[...(await fs.list("m"))].sort().at(-1)!}`;
    const buf = (await fs.read(path, 0, Number.POSITIVE_INFINITY))!;
    new DataView(buf.buffer).setUint32(4, 2, true);
    new DataView(buf.buffer).setUint32(buf.byteLength - 4, crc32(buf.subarray(0, buf.byteLength - 4)), true);
    const w = await fs.create(path);
    await w.write(buf);
    await w.finish();

    const files = async () => ({ m: await fs.list("m"), l0: await fs.list("l0") });
    const before = await files();
    await expect(open()).rejects.toThrow(CorruptDatabaseError);
    expect(await files()).toEqual(before);
  });
});
