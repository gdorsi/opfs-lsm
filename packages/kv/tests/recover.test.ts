import { afterEach, describe, expect, it } from "vitest";
import { checkDbName, checkKey, checkValue, opsBytes, type CheckedOp } from "../src/check.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { IdBWal } from "../src/idb/wal.js";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../src/index.js";
import { reconcile } from "../src/recover.js";
import { crc32 } from "../src/store/crc32.js";
import { publishGeneration, type GenerationMeta } from "../src/store/generation.js";
import { openHarnessDb, ingest } from "../src/testing.js";
import { publish } from "./runs.js";
import { checkDatabase, deleteWal, walRows, walStore } from "./sim/check-database.js";

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
  for (const path of runs) await publish(fs, path, new Uint8Array([1]));
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

/** A `meta` value, or undefined when the key was never written. */
function metaRaw(dbName: string, key: string): Promise<unknown> {
  return walStore(dbName, "readonly", (_wal, meta) => meta.get(key));
}

/**
 * The state the "drops the WAL" case leaves: every row deleted, `ingestedThrough`
 * at the last committed seq, and the head held by the `meta.head` floor.
 */
async function droppedWal(): Promise<{ fs: MemoryFs; dbName: string }> {
  const wal = await walWith(4);
  const dbName = name;
  const fs = new MemoryFs();
  await wal.advanceIngested(1, 1);
  await wal.advanceIngested(2, 2);
  await wal.advanceIngested(3, 3);
  expect((await reconcile(wal, fs, trustNone)).generation).toBe(0);
  expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 4, generation: 0 });
  expect(await walRows(dbName)).toEqual([]);
  expect(await metaRaw(dbName, "head")).toBe(4);
  wal.close();
  return { fs, dbName };
}

describe("advanceIngested", () => {
  it("keeps the head on the last wal key after older rows are deleted", async () => {
    // Appends write no `meta.head` floor. The head is the last key, including
    // once ingest has deleted every row of the previous batch.
    const wal = await walWith(4);
    expect(await metaRaw(name, "head")).toBeUndefined();
    expect(await metaRaw(name, "pendingBytes")).toBeUndefined();
    await wal.advanceIngested(2, 1);
    await wal.advanceIngested(4, 2);
    expect(await metaRaw(name, "head")).toBeUndefined();
    expect((await walRows(name)).map((r) => r.seq)).toEqual([3, 4]);
    expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 4 });
    expect((await wal.tail(0)).head).toBe(4);
    const next = await wal.appendAfter(0, () => ({ ops: put(5), result: 0 }));
    expect(next?.seq).toBe(5);
    await wal.advanceIngested(5, 3);
    expect((await walRows(name)).map((r) => r.seq)).toEqual([5]);
    expect(await wal.meta()).toMatchObject({ head: 5, ingestedThrough: 5 });
    expect((await wal.tail(0)).head).toBe(5);
    expect((await wal.appendAfter(0, () => ({ ops: put(6), result: 0 })))?.seq).toBe(6);
    wal.close();
  });

  it("keeps the records it folded until the next ingest", async () => {
    const wal = await walWith(3);
    await wal.advanceIngested(2, 1);
    // Seqs 1 and 2 stay: a power loss can keep this commit and lose manifest 1.
    expect(await wal.adopt(await wal.meta(), 0, 0)).toBe(true);
    expect(await seqs(wal)).toEqual([1, 2, 3]);
    expect(await wal.uningestedBytes()).toBe(3 * opsBytes(put(1)));
    wal.close();
  });

  it("drops them at the next ingest", async () => {
    const wal = await walWith(3);
    await wal.advanceIngested(2, 1);
    await wal.advanceIngested(3, 2);
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
    await wal.advanceIngested(1, 1);
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
    await wal.advanceIngested(1, 1);
    await wal.advanceIngested(3, 2);
    expect((await reconcile(wal, fs, trustNone)).generation).toBe(1);
    expect(await wal.meta()).toMatchObject({ head: 4, ingestedThrough: 1, generation: 1 });
    expect(await seqs(wal)).toEqual([2, 3, 4]);
    wal.close();
  });

  it("drops the WAL when the seqs between the manifest and it are gone", async () => {
    const wal = await walWith(4);
    const fs = new MemoryFs();
    await wal.advanceIngested(1, 1);
    await wal.advanceIngested(2, 2);
    await wal.advanceIngested(3, 3);
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
    await wal.advanceIngested(2, 2);
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
    await wal.advanceIngested(3, 3);
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
    await wal.advanceIngested(1, 3);
    expect(await reconcile(wal, fs, trustNone)).toEqual({ generation: 0, top: 3 });
    expect(await reconcile(wal, fs, trustAll)).toEqual({ generation: 0, top: 3 });
    wal.close();
  });

  it("never lowers the head when adopt deletes wal rows", async () => {
    // Every delete bound adopt uses: a manifest behind the log, one the WAL
    // still follows, and one past the head (which drops every row).
    let emptied = 0;
    for (const through of [0, 1, 2, 3, 4, 8]) {
      const wal = await walWith(4);
      const dbName = name;
      try {
        await wal.advanceIngested(2, 1);
        await wal.advanceIngested(4, 2);
        const before = await wal.meta();
        expect(before.head).toBe(4);
        expect(await wal.adopt(before, 0, through)).toBe(true);
        const after = await wal.meta();
        expect(after.head).toBeGreaterThanOrEqual(before.head);
        expect(after.head).toBeGreaterThanOrEqual(after.ingestedThrough);
        const rows = await walRows(dbName);
        if (rows.length === 0) {
          emptied += 1;
          // The floor, not a leftover key, is what keeps the head from falling.
          expect(await metaRaw(dbName, "head")).toBe(after.head);
        }
        const seq = (await wal.appendAfter(0, () => ({ ops: put(9), result: 0 })))?.seq;
        expect(seq).toBe(after.head + 1);
        expect(seq).toBeGreaterThan(after.ingestedThrough);
      } finally {
        wal.close();
        await deleteWal(dbName);
      }
    }
    expect(emptied).toBeGreaterThan(0);
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

describe("the next write after adopt empties the wal", () => {
  const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

  async function openDropped() {
    const { fs, dbName } = await droppedWal();
    const db = await openHarnessDb({
      name: dbName,
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
    });
    return { fs, dbName, db };
  }

  it("update appends at head + 1", async () => {
    const { fs, dbName, db } = await openDropped();
    try {
      await db.update([], (_values, tx) => {
        tx.put(enc.encode("n"), enc.encode("x"));
      });
      expect(text(await db.get(enc.encode("n")))).toBe("x");
      const report = await checkDatabase(fs, dbName);
      expect(report.problems).toEqual([]);
      expect(report.head).toBe(5);
      expect(report.ingestedThrough).toBe(4);
    } finally {
      await db.close();
      await deleteWal(dbName);
    }
  });

  it("put appends at head + 1", async () => {
    const { fs, dbName, db } = await openDropped();
    try {
      await db.put(enc.encode("n"), enc.encode("x"));
      expect(text(await db.get(enc.encode("n")))).toBe("x");
      const report = await checkDatabase(fs, dbName);
      expect(report.problems).toEqual([]);
      expect(report.head).toBe(5);
      expect(report.ingestedThrough).toBe(4);
    } finally {
      await db.close();
      await deleteWal(dbName);
    }
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
    await ingest(db);
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
    await ingest(db);
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
    await ingest(db);
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
    await ingest(db);
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

/**
 * An older build reads `meta.head` as the head and never the last WAL key.
 * Its adopt and `advanceIngested` are the copies those builds still run
 * (`IdBWal` at the parent of the record-only append). Both delete with
 * `IDBKeyRange.upperBound` of a seq they read from `meta`, which is at most
 * the stored floor.
 */
function idbDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

async function legacyMeta(dbName: string): Promise<{
  head: number;
  ingestedThrough: number;
  generation: number | undefined;
  top: number;
}> {
  return walStore(dbName, "readonly", async (_wal, meta) => {
    const [head, ingested, generation, top] = await Promise.all(
      ["head", "ingestedThrough", "generation", "topGeneration"].map((k) => idbDone(meta.get(k))),
    );
    return {
      head: num(head),
      ingestedThrough: num(ingested),
      generation: typeof generation === "number" ? generation : undefined,
      top: num(top),
    };
  });
}

/** Records an older build's `listUningested` would return: `(ingestedThrough, meta.head]`. */
async function legacyUningested(dbName: string): Promise<number[]> {
  return walStore(dbName, "readonly", async (wal, meta) => {
    const [through, head] = await Promise.all([
      idbDone(meta.get("ingestedThrough")).then(num),
      idbDone(meta.get("head")).then(num),
    ]);
    if (head <= through) return [];
    const keys = await idbDone(wal.getAllKeys(IDBKeyRange.bound(through + 1, head)));
    return keys.map(Number);
  });
}

/** Older `adopt`: the else branch deletes `upperBound(head)` where `head` is the stored floor. */
async function legacyAdopt(
  dbName: string,
  expect: { head: number; ingestedThrough: number; generation: number | undefined; top: number },
  generation: number,
  through: number,
  floor = through,
  top = generation,
): Promise<boolean> {
  return walStore(dbName, "readwrite", async (wal, meta) => {
    const [head, ingested, recorded, knownTop] = await Promise.all([
      idbDone(meta.get("head")).then(num),
      idbDone(meta.get("ingestedThrough")).then(num),
      idbDone(meta.get("generation")),
      idbDone(meta.get("topGeneration")).then(num),
    ]);
    if (
      head !== expect.head ||
      knownTop !== expect.top ||
      ingested !== expect.ingestedThrough ||
      (typeof recorded === "number" ? recorded : undefined) !== expect.generation
    ) {
      return false;
    }
    const above = head > through ? await idbDone(wal.getAll(IDBKeyRange.bound(through + 1, head))) : [];
    const nextHead = Math.max(head, through, floor);
    let nextIngested = through;
    if (nextHead === head && (through >= ingested || above.length === head - through)) {
      wal.delete(IDBKeyRange.upperBound(Math.min(ingested, through)));
    } else {
      nextIngested = nextHead;
      wal.delete(IDBKeyRange.upperBound(head));
    }
    meta.put(nextHead, "head");
    meta.put(nextIngested, "ingestedThrough");
    meta.put(generation, "generation");
    meta.put(Math.max(knownTop, top, generation), "topGeneration");
    meta.put(0, "pendingBytes");
    return true;
  });
}

/** Older `advanceIngested`: deletes records at or below the previous `ingestedThrough`. */
async function legacyAdvance(dbName: string, through: number, generation: number): Promise<void> {
  await walStore(dbName, "readwrite", async (wal, meta) => {
    const [existing, prevGen] = await Promise.all([
      idbDone(meta.get("ingestedThrough")).then(num),
      idbDone(meta.get("generation")).then(num),
    ]);
    if (through > existing) {
      wal.delete(IDBKeyRange.upperBound(existing));
      meta.put(through, "ingestedThrough");
      meta.put(Math.max(prevGen, generation), "generation");
      meta.put(0, "pendingBytes");
    }
  });
}

describe("an older build sharing the database", () => {
  it("misses records past the floor, and adopt and truncation do not drop them", async () => {
    const wal = await walWith(0);
    const fs = new MemoryFs();
    // Open records the floor. Appends after that leave it there; an open
    // that finds records already waiting snaps the floor up to them.
    expect(await reconcile(wal, fs, trustAll)).toEqual({ generation: 0, top: 0 });
    for (let i = 1; i <= 4; i++) await wal.append(put(i));
    await wal.advanceIngested(2, 1);
    expect((await legacyMeta(name)).head).toBe(0);
    expect((await wal.meta()).head).toBe(4);
    // A reload of the older build reads the same floor.
    expect(await legacyUningested(name)).toEqual([]);
    expect(await seqs(wal)).toEqual([3, 4]);

    const older = await legacyMeta(name);
    // Manifest through is past the floor, so the older adopt takes the else branch.
    expect(await legacyAdopt(name, older, 1, 2, 2, 1)).toBe(true);
    expect((await walRows(name)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    // The floor is now the manifest through. Records past it are still
    // invisible, so the older ingest has nothing to advance over.
    expect(await legacyUningested(name)).toEqual([]);
    expect(await seqs(wal)).toEqual([3, 4]);
    wal.close();
  });

  it("truncates only the prefix at or below the previous ingestedThrough", async () => {
    const wal = await walWith(4);
    // The older build committed seqs 1 and 2, then this build appended 3 and 4.
    await walStore(name, "readwrite", (_wal, meta) => meta.put(2, "head"));
    expect(await legacyUningested(name)).toEqual([1, 2]);
    await legacyAdvance(name, 2, 1);
    expect((await walRows(name)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(await seqs(wal)).toEqual([3, 4]);
    wal.close();
  });

  it("drops only up to a stale head when the record count above it does not match", async () => {
    const wal = await walWith(4);
    // Floor 2, seq 1 already ingested and removed. The count of records in
    // (0, 2] is short, and `through` is below `ingestedThrough`, so adopt
    // takes the else branch. Its delete bound is the floor, not seq 4.
    await walStore(name, "readwrite", (store, meta) => {
      store.delete(1);
      meta.put(2, "head");
      meta.put(1, "ingestedThrough");
    });
    const older = await legacyMeta(name);
    expect(older.head).toBe(2);
    expect(await legacyUningested(name)).toEqual([2]);
    expect(await legacyAdopt(name, older, 0, 0, 0, 0)).toBe(true);
    expect((await walRows(name)).map((r) => r.seq)).toEqual([3, 4]);
    expect(await seqs(wal)).toEqual([3, 4]);
    wal.close();
  });
});
