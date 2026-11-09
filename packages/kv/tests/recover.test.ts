import { afterEach, describe, expect, it } from "vitest";
import { checkDbName, checkKey, checkValue, opsBytes, type CheckedOp } from "../src/check.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { IdBWal } from "../src/idb/wal.js";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../src/index.js";
import { reconcile } from "../src/recover.js";
import { crc32 } from "../src/store/crc32.js";
import { publishGeneration, publishRun, type GenerationMeta } from "../src/store/generation.js";
import { openHarnessDb } from "../src/testing.js";
import { checkDatabase, deleteWal } from "./sim/check-database.js";

/**
 * `reconcile` and `IdBWal.adopt` (design.md, "Recovery"): after a power
 * loss, the open records a manifest that pairs with the WAL. The crash
 * enumeration in tests/sim/crash-enum.test.ts checks every crash state;
 * these pin each branch.
 */
const enc = new TextEncoder();
let n = 0;
let name = "";
afterEach(() => deleteWal(name));

function put(i: number): CheckedOp[] {
  return [{ type: "put", key: checkKey(enc.encode(`k${i}`)), value: checkValue(enc.encode(`v${i}`)) }];
}

async function walWith(appends: number): Promise<IdBWal> {
  name = `recover-${++n}`;
  const wal = await IdBWal.open(checkDbName(name));
  for (let i = 1; i <= appends; i++) await wal.append(put(i));
  return wal;
}

/** A manifest with one (fake) non-empty run per name. */
async function manifest(fs: MemoryFs, generation: number, through: number, runs: string[]): Promise<GenerationMeta> {
  for (const path of runs) await publishRun(fs, path, new Uint8Array([1]));
  const meta = { generation, runs: runs.map((path) => ({ path, bytes: 1 })), tombstoneSeq: 0, through };
  await publishGeneration(fs, meta);
  return meta;
}

/** Flip one byte of the newest manifest, as a disk fault would and a power loss cannot. */
async function flipByte(fs: MemoryFs, dir: string): Promise<void> {
  const path = dir + (await fs.list("m")).sort().at(-1)!;
  const buf = (await fs.read(path, 0, Number.POSITIVE_INFINITY))!;
  buf[buf.byteLength >> 1]! ^= 0xff;
  const w = await fs.create(path);
  await w.write(buf);
  await w.finish();
}

const seqs = async (wal: IdBWal) => (await wal.listUningested()).map((r) => r.seq);
const trustAll = () => true;
const trustNone = () => false;

describe("advanceIngested", () => {
  it("keeps the records it folded until the next ingest", async () => {
    const wal = await walWith(3);
    await wal.advanceIngested(2, 1, opsBytes(put(1)) + opsBytes(put(2)));
    // Seqs 1 and 2 stay: a power loss can keep this commit and lose manifest 1.
    expect(await wal.adopt(await wal.meta(), 0, 0)).toBe(true);
    expect(await seqs(wal)).toEqual([1, 2, 3]);
    expect(await wal.uningestedBytes()).toBe(3 * opsBytes(put(1)));
    wal.close();
  });

  it("drops them at the next ingest", async () => {
    const wal = await walWith(3);
    await wal.advanceIngested(2, 1, 0);
    await wal.advanceIngested(3, 2, 0);
    // Seqs 1..2 are gone, so a manifest through 0 cannot be followed.
    expect(await wal.adopt(await wal.meta(), 0, 0)).toBe(true);
    expect(await wal.meta()).toMatchObject({ head: 3, ingestedThrough: 3, generation: 0 });
    expect(await seqs(wal)).toEqual([]);
    wal.close();
  });
});

describe("reconcile", () => {
  it("keeps a recorded generation whose manifest pairs with the WAL", async () => {
    const wal = await walWith(2);
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, ["l0/1-1.sst"]);
    await wal.advanceIngested(1, 1, 0);
    const before = await wal.meta();
    expect(await reconcile(wal, fs, trustNone)).toEqual({ generation: 1, top: 1 });
    expect(await wal.meta()).toEqual(before);
    wal.close();
  });

  it("records generation 0 on a new database", async () => {
    const wal = await walWith(0);
    expect(await reconcile(wal, new MemoryFs(), trustAll)).toEqual({ generation: 0, top: 0 });
    expect(await wal.meta()).toMatchObject({ head: 0, ingestedThrough: 0, generation: 0 });
    wal.close();
  });

  it("adopts a manifest that holds seqs past the head, and moves the head past them", async () => {
    // IndexedDB lost everything; OPFS kept manifest 1 through seq 2.
    const wal = await walWith(0);
    const fs = new MemoryFs();
    await manifest(fs, 1, 2, ["l0/1-2.sst"]);
    expect(await reconcile(wal, fs, trustAll)).toEqual({ generation: 1, top: 1 });
    expect(await wal.meta()).toMatchObject({ head: 2, ingestedThrough: 2, generation: 1 });
    // The key generator is behind the head, so the blind append gives way
    // and the explicit one takes seq 3.
    expect(await wal.append(put(3))).toBeUndefined();
    expect((await wal.appendAfter(2, () => ({ ops: put(3), result: 0 })))?.seq).toBe(3);
    wal.close();
  });

  it("adopts a newer manifest past the head even while the recorded one is intact", async () => {
    // IndexedDB kept seq 1 of 4; OPFS kept manifest 2 through 4.
    const wal = await walWith(1);
    const fs = new MemoryFs();
    await wal.adopt(await wal.meta(), 0, 0);
    await manifest(fs, 2, 4, ["l0/1-2.sst", "l0/3-4.sst"]);
    expect((await reconcile(wal, fs, trustAll)).generation).toBe(2);
    expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 4, generation: 2 });
    expect(await seqs(wal)).toEqual([]);
    wal.close();
  });

  it("ignores a newer manifest the WAL still covers: a crash left it, and the WAL holds its seqs", async () => {
    const wal = await walWith(3);
    const fs = new MemoryFs();
    await wal.adopt(await wal.meta(), 0, 0);
    await manifest(fs, 1, 3, ["l0/1-3.sst"]);
    expect(await reconcile(wal, fs, trustAll)).toEqual({ generation: 0, top: 1 });
    expect(await seqs(wal)).toEqual([1, 2, 3]);
    wal.close();
  });

  it("falls back to the newest intact manifest when the recorded one is gone, and replays the kept records", async () => {
    // IndexedDB recorded generation 2 through 3; OPFS lost manifest 2.
    const wal = await walWith(4);
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, ["l0/1-1.sst"]);
    await wal.advanceIngested(1, 1, 0);
    await wal.advanceIngested(3, 2, 0);
    expect((await reconcile(wal, fs, trustNone)).generation).toBe(1);
    expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 1, generation: 1 });
    expect(await seqs(wal)).toEqual([2, 3, 4]);
    wal.close();
  });

  it("drops the WAL when the seqs between the manifest and it are gone", async () => {
    const wal = await walWith(4);
    const fs = new MemoryFs();
    await wal.advanceIngested(1, 1, 0);
    await wal.advanceIngested(2, 2, 0);
    await wal.advanceIngested(3, 3, 0);
    // Only generation 0 is left: seqs 1..1 are gone from both stores.
    expect((await reconcile(wal, fs, trustNone)).generation).toBe(0);
    expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 4, generation: 0 });
    expect(await seqs(wal)).toEqual([]);
    wal.close();
  });

  it("skips a manifest whose runs are gone, but never hands out its seqs again", async () => {
    const wal = await walWith(0);
    const fs = new MemoryFs();
    await manifest(fs, 1, 2, ["l0/1-2.sst"]);
    const broken = await manifest(fs, 2, 5, ["l0/3-5.sst", "l0/1-2.sst"]);
    await fs.remove(broken.runs[0]!.path);
    expect((await reconcile(wal, fs, trustAll)).generation).toBe(1);
    expect(await wal.meta()).toMatchObject({ head: 5, ingestedThrough: 5, generation: 1 });
    wal.close();
  });

  it("refuses a recorded manifest that does not decode, and writes nothing", async () => {
    const wal = await walWith(2);
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, ["l0/1-1.sst"]);
    await manifest(fs, 2, 2, ["l0/1-1.sst", "l0/2-2.sst"]);
    await wal.advanceIngested(2, 2, 0);
    await flipByte(fs, "m/");
    const before = await wal.meta();
    await expect(reconcile(wal, fs, trustNone)).rejects.toThrow(CorruptDatabaseError);
    expect(await wal.meta()).toEqual(before);
    wal.close();
  });

  it("refuses a manifest that does not decode before the newest intact one when the recorded one is gone", async () => {
    const wal = await walWith(3);
    const fs = new MemoryFs();
    await manifest(fs, 1, 1, ["l0/1-1.sst"]);
    await manifest(fs, 2, 2, ["l0/1-1.sst", "l0/2-2.sst"]);
    await wal.advanceIngested(3, 3, 0);
    await flipByte(fs, "m/");
    const before = await wal.meta();
    await expect(reconcile(wal, fs, trustNone)).rejects.toThrow(CorruptDatabaseError);
    expect(await wal.meta()).toEqual(before);
    wal.close();
  });

  it("never reuses a manifest number after recording an older manifest", async () => {
    // IndexedDB recorded generation 3 (through 1); OPFS lost manifest 3.
    // Falling back to generation 0 must not let the next ingest call its
    // manifest 1..3: IndexedDB may still name 3 after another power loss.
    const wal = await walWith(2);
    const fs = new MemoryFs();
    await wal.advanceIngested(1, 3, 0);
    expect(await reconcile(wal, fs, trustNone)).toEqual({ generation: 0, top: 3 });
    expect(await reconcile(wal, fs, trustAll)).toEqual({ generation: 0, top: 3 });
    wal.close();
  });

  it("writes nothing when the WAL changed since it was read", async () => {
    const wal = await walWith(1);
    const stale = await wal.meta();
    await wal.append(put(2));
    expect(await wal.adopt(stale, 0, 0)).toBe(false);
    expect(await wal.meta()).toEqual({ head: 2, ingestedThrough: 0, generation: undefined, top: 0 });
    wal.close();
  });
});

/**
 * Chrome sometimes deletes every IndexedDB database of an origin after a
 * browser crash, and leaves OPFS alone (docs/verification.md, "Kill real
 * Chrome"). To the engine that is an IndexedDB power loss: the open records
 * the newest manifest and moves `head` past it.
 */
describe("a deleted WAL", () => {
  const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

  async function seeded(open: () => ReturnType<typeof openHarnessDb>) {
    const db = await open();
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.ingest();
    await db.put(enc.encode("b"), enc.encode("2"));
    return db;
  }

  it("reopens to the ingested prefix", async () => {
    name = `recover-${++n}`;
    const fs = new MemoryFs();
    const open = () => openHarnessDb({ name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    await (await seeded(open)).close();
    await deleteWal(name);
    const db = await open();
    expect(text(await db.get(enc.encode("a")))).toBe("1");
    expect(await db.get(enc.encode("b"))).toBeUndefined();
    await db.put(enc.encode("c"), enc.encode("3"));
    await db.ingest();
    await db.close();
    const report = await checkDatabase(fs, name);
    expect(report.problems).toEqual([]);
    expect(report.head).toBe(2);
  });

  it("under an open handle: the handle fails, a new one reads the prefix", async () => {
    name = `recover-${++n}`;
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const open = () => openHarnessDb({ name, fs, ingest: createLocalIngestClient(host) });
    const old = await seeded(open);
    await deleteWal(name);
    // The raw IndexedDB error, not an OpfsLsmError.
    await expect(old.put(enc.encode("x"), enc.encode("9"))).rejects.toMatchObject({ name: "InvalidStateError" });
    const db = await open();
    expect(text(await db.get(enc.encode("a")))).toBe("1");
    await db.put(enc.encode("c"), enc.encode("3"));
    await db.ingest();
    await db.close();
    await old.close().catch(() => undefined);
    const report = await checkDatabase(fs, name);
    expect(report.problems).toEqual([]);
    expect(report.state.map((e) => text(e.key))).toEqual(["a", "c"]);
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
    const open = () => openHarnessDb({ name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
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
