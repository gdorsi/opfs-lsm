import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
} from "../src/testing.js";
import type { Db } from "../src/index.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { BrowserFs, findBrowserFs, findRemovableBrowserFs, openBrowserFs } from "../src/opfs/browser-fs.js";
import { checkDbName } from "../src/check.js";
import { compactHost } from "./compact-host.js";
import { fakeOpfs, type FakeDir } from "./fake-opfs.js";

const NAME = "file-holds";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

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

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

async function openWithHost(fs: MemoryFs) {
  const host = new EngineHost(() => fs);
  const db = await openHarnessDb({
    name: NAME,
    writerId: "w1",
    fs,
    ingest: createLocalIngestClient(host),
    maxWalBytes: 1e12,
  });
  return { db, host };
}

/** Three L0 runs: one more flush starts a compaction into L1. */
async function threeRuns(db: Awaited<ReturnType<typeof openWithHost>>["db"]) {
  for (let i = 0; i < 3; i++) {
    await db.put(utf(`k${i}`), utf(`v${i}`));
    await ingest(db);
  }
}

const l0 = (fs: MemoryFs) => fs.publishedPaths().filter((p) => p.startsWith("l0/"));
const l1 = (fs: MemoryFs) => fs.publishedPaths().filter((p) => p.startsWith("l1/"));
const runFiles = (fs: MemoryFs) => fs.publishedPaths().filter((p) => /^l\d+\//.test(p)).sort();

describe("run files outlive compaction while a tab reads them", () => {
  it("a view opened before a compaction reads every key, and its inputs go after it closes", async () => {
    const fs = new MemoryFs();
    const { db } = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);
    expect(inputs).toHaveLength(3);

    const seen = await db.view(async (snap) => {
      await db.put(utf("k3"), utf("v3"));
      await ingest(db);
      await ingest(db);
      expect(l1(fs).length).toBeGreaterThan(0);
      expect(l0(fs)).toEqual(expect.arrayContaining(inputs));
      const got: string[] = [];
      for (let i = 0; i < 3; i++) got.push(dec.decode((await snap.get(utf(`k${i}`)))!));
      const keys: string[] = [];
      for await (const e of snap.range()) keys.push(dec.decode(e.key));
      return { got, keys, k3: await snap.get(utf("k3")) };
    });
    expect(seen).toEqual({ got: ["v0", "v1", "v2"], keys: ["k0", "k1", "k2"], k3: undefined });

    await ingest(db);
    expect(l0(fs)).toEqual([]);
    for (let i = 0; i < 4; i++) expect(dec.decode((await db.get(utf(`k${i}`)))!)).toBe(`v${i}`);
    await db.close();
  });

  it("a range iterator holds its generation until return()", async () => {
    const fs = new MemoryFs();
    const { db } = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);

    const it = db.range()[Symbol.asyncIterator]();
    expect(dec.decode((await it.next()).value!.key)).toBe("k0");
    await db.put(utf("k3"), utf("v3"));
    await ingest(db);
    await ingest(db);
    expect(l1(fs).length).toBeGreaterThan(0);
    expect(l0(fs)).toEqual(expect.arrayContaining(inputs));
    expect(dec.decode((await it.next()).value!.key)).toBe("k1");

    await it.return!();
    await ingest(db);
    expect(l0(fs)).toEqual([]);
    await db.close();
  });

  const coldReads: [string, (db: Db) => Promise<unknown>, unknown][] = [
    ["get", async (db) => dec.decode((await db.get(utf("k1")))!), "v1"],
    ["getMany", async (db) => (await db.getMany([utf("k0"), utf("k2")])).map((v) => dec.decode(v!)), ["v0", "v2"]],
    ["count", (db) => db.count(), 3],
  ];

  it.each(coldReads)("a cold %s keeps the runs it waits on until it has read them", async (_what, read, want) => {
    const fs = new MemoryFs();
    const { db, host } = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);
    let lift = () => {};
    let arrived = () => {};
    let gate: Promise<void> | undefined;
    const gated: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      open: async (path) => {
        const file = await fs.open(path);
        return (
          file && {
            size: file.size,
            read: async (offset, length) => {
              if (gate) {
                arrived();
                await gate;
              }
              return file.read(offset, length);
            },
            close: () => file.close(),
          }
        );
      },
    };
    const reader = await openHarnessDb({
      name: NAME,
      writerId: "r",
      fs: gated,
      ingest: createLocalIngestClient(host),
      maxWalBytes: 1e12,
    });
    gate = new Promise((resolve) => (lift = resolve));
    const waiting = new Promise<void>((resolve) => (arrived = resolve));
    const got = read(reader);
    await waiting;

    await db.put(utf("k3"), utf("v3"));
    await ingest(db);
    await ingest(db);
    await reader.sync();
    await ingest(db);
    expect(l0(fs)).toEqual(expect.arrayContaining(inputs));

    gate = undefined;
    lift();
    expect(await got).toEqual(want);
    await reader.close();
    await ingest(db);
    expect(l0(fs)).toEqual([]);
    await db.close();
  });

  it("closing the database releases its runs", async () => {
    const fs = new MemoryFs();
    const { db } = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);
    expect(await fs.removeUnlessOpen(inputs[0]!)).toBe(false);
    await db.close();
    expect(await Promise.all(inputs.map((p) => fs.removeUnlessOpen(p)))).toEqual([true, true, true]);
  });
});

describe("host boot sweep", () => {
  it("removes run files no generation lists and keeps the live ones", async () => {
    const fs = new MemoryFs();
    const first = await openWithHost(fs);
    await threeRuns(first.db);
    await first.db.close();
    const live = l0(fs);
    for (const path of ["l0/crashed-flush.sst", "l1/c9.0-100.sst"]) {
      const w = await fs.create(path);
      await w.write(utf("orphan"));
      await w.finish();
    }

    const { db } = await openWithHost(fs);
    await ingest(db);
    expect(runFiles(fs)).toEqual([...live].sort());
    for (let i = 0; i < 3; i++) expect(dec.decode((await db.get(utf(`k${i}`)))!)).toBe(`v${i}`);
    await db.close();
  });

  it("a host that already swept removes a run file that turns up later", async () => {
    const fs = new MemoryFs();
    const { db, host } = await openWithHost(fs);
    await threeRuns(db);
    await compactHost(host, NAME);
    const live = runFiles(fs);
    // What a failed install or another host's compaction leaves behind.
    const w = await fs.create("l1/c9.0-100.sst");
    await w.write(utf("orphan"));
    await w.finish();

    await compactHost(host, NAME);
    expect(runFiles(fs)).toEqual(live);
    await db.close();
  });
});

let browserDbs = 0;
const fsKinds: [string, () => AsyncFs][] = [
  ["MemoryFs", () => new MemoryFs()],
  [
    "BrowserFs",
    () =>
      new BrowserFs(
        fakeOpfs() as unknown as FileSystemDirectoryHandle,
        checkDbName(`holds-${++browserDbs}`),
      ),
  ],
];

describe.each(fsKinds)("%s open files", (_kind, makeFs) => {
  async function withFile(fs: AsyncFs, path: string, body: string) {
    const w = await fs.create(path);
    await w.write(utf(body));
    await w.finish();
  }

  it("reads exact ranges and refuses a read past the end", async () => {
    const fs = makeFs();
    await withFile(fs, "l1/a-5.sst", "hello");
    const file = (await fs.open("l1/a-5.sst"))!;
    expect(file.size).toBe(5);
    expect(dec.decode(await file.read(1, 3))).toBe("ell");
    await expect(file.read(3, 3)).rejects.toThrow(/short read/);
    file.close();
  });

  it("keeps a file while any hold is open", async () => {
    const fs = makeFs();
    await withFile(fs, "l1/a-1.sst", "x");
    const a = (await fs.open("l1/a-1.sst"))!;
    const b = (await fs.open("l1/a-1.sst"))!;
    expect(await fs.removeUnlessOpen("l1/a-1.sst")).toBe(false);
    a.close();
    a.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(await fs.removeUnlessOpen("l1/a-1.sst")).toBe(false);
    b.close();
    await vi.waitFor(async () => expect(await fs.removeUnlessOpen("l1/a-1.sst")).toBe(true));
    expect(await fs.read("l1/a-1.sst", 0, 1)).toBeUndefined();
    expect(await fs.removeUnlessOpen("l1/a-1.sst")).toBe(true);
  });

  it("opening a missing file leaves no hold", async () => {
    const fs = makeFs();
    expect(await fs.open("l0/gone.sst")).toBeUndefined();
    await withFile(fs, "l0/gone.sst", "x");
    expect(await fs.removeUnlessOpen("l0/gone.sst")).toBe(true);
  });

  it("lists the top-level directories", async () => {
    const fs = makeFs();
    await withFile(fs, "l0/a.sst", "x");
    await withFile(fs, "l2/b.sst", "x");
    await withFile(fs, "m/1.mft", "x");
    expect([...(await fs.list(""))].sort()).toEqual(["l0", "l2", "m"]);
  });
});

describe("BrowserFs folder lookup and removal", () => {
  const root = fakeOpfs();
  beforeEach(() => vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } }));
  afterEach(() => vi.unstubAllGlobals());

  it("finds a folder without creating one, and removes m/ before the folder", async () => {
    expect(await findBrowserFs("absent")).toBeUndefined();
    expect([...root.children.keys()]).toEqual([]);
    const made = await openBrowserFs("present");
    for (const path of ["l0/1-2.sst", "m/0000000000000001.mft", "l1/c2.0.sst"]) {
      const w = await made.create(path);
      await w.write(utf("x"));
      await w.finish();
    }
    expect(await findBrowserFs("absent")).toBeUndefined();
    const lsm = root.children.get("opfs-lsm") as FakeDir;
    expect([...lsm.children.keys()]).toEqual(["present"]);

    expect([...(await (await findBrowserFs("present"))!.list(""))].sort()).toEqual(["l0", "l1", "m"]);
    const found = (await findRemovableBrowserFs(checkDbName("present")))!;
    expect([...(await found.list(""))].sort()).toEqual(["l0", "l1", "m"]);
    root.origin.removals.length = 0;
    await found.removeFolder();

    expect(root.origin.removals).toEqual(["m", "present"]);
    expect([...lsm.children.keys()]).toEqual([]);
    await found.removeFolder();
    expect(await findBrowserFs("present")).toBeUndefined();
  });
});
