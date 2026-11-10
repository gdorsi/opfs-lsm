import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Host, MemoryFs, openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";
import type { Db } from "../src/index.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { BrowserFs } from "../src/opfs/browser-fs.js";
import { checkDbName } from "../src/check.js";

const NAME = "file-holds";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

/** A page on its own host, as after a SharedWorker restart. */
const openWithHost = (fs: MemoryFs): Promise<Db> => openHarnessDb({ name: NAME, fs, host: new Host(() => fs) });

/** Three L0 runs: one more ingest starts a compaction into L1. */
async function threeRuns(db: Db) {
  for (let i = 0; i < 3; i++) {
    await db.put(utf(`k${i}`), utf(`v${i}`));
    await db.ingest();
  }
}

/** Three more manifests, so the kept ones (RECLAIM_LAG + 1) no longer list what compaction replaced. */
async function threeManifests(db: Db) {
  for (let i = 0; i < 3; i++) {
    await db.put(utf(`pad${i}`), utf("x"));
    await db.ingest();
  }
}

const l0 = (fs: MemoryFs) => fs.publishedPaths().filter((p) => p.startsWith("l0/"));
const l1 = (fs: MemoryFs) => fs.publishedPaths().filter((p) => p.startsWith("l1/"));
const left = (fs: MemoryFs, paths: readonly string[]) => paths.filter((p) => fs.publishedPaths().includes(p));

describe("run files outlive compaction while a tab reads them", () => {
  it("a view opened before a compaction reads every key, and its inputs go after it closes", async () => {
    const fs = new MemoryFs();
    const db = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);
    expect(inputs).toHaveLength(3);

    const seen = await db.view(async (snap) => {
      await db.put(utf("k3"), utf("v3"));
      await db.ingest();
      expect(l1(fs).length).toBeGreaterThan(0);
      await threeManifests(db);
      expect(left(fs, inputs), "the view holds them").toEqual(inputs);
      const got: string[] = [];
      for (let i = 0; i < 3; i++) got.push(dec.decode((await snap.get(utf(`k${i}`)))!));
      const keys: string[] = [];
      for await (const e of snap.range()) keys.push(dec.decode(e.key));
      return { got, keys, k3: await snap.get(utf("k3")) };
    });
    expect(seen).toEqual({ got: ["v0", "v1", "v2"], keys: ["k0", "k1", "k2"], k3: undefined });

    await db.ingest();
    expect(left(fs, inputs)).toEqual([]);
    for (let i = 0; i < 4; i++) expect(dec.decode((await db.get(utf(`k${i}`)))!)).toBe(`v${i}`);
    await db.close();
  });

  it("a range iterator holds its generation until return()", async () => {
    const fs = new MemoryFs();
    const db = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);

    const it = db.range()[Symbol.asyncIterator]();
    expect(dec.decode((await it.next()).value!.key)).toBe("k0");
    await db.put(utf("k3"), utf("v3"));
    await db.ingest();
    expect(l1(fs).length).toBeGreaterThan(0);
    await threeManifests(db);
    expect(left(fs, inputs)).toEqual(inputs);
    expect(dec.decode((await it.next()).value!.key)).toBe("k1");

    await it.return!();
    await db.ingest();
    expect(left(fs, inputs)).toEqual([]);
    await db.close();
  });

  it("closing the database releases its runs", async () => {
    const fs = new MemoryFs();
    const db = await openWithHost(fs);
    await threeRuns(db);
    const inputs = l0(fs);
    expect(await fs.removeUnlessOpen(inputs[0]!)).toBe(false);
    await db.close();
    expect(await Promise.all(inputs.map((p) => fs.removeUnlessOpen(p)))).toEqual([true, true, true]);
  });
});

describe("host boot sweep", () => {
  it("removes run files no manifest lists and keeps the live ones", async () => {
    const fs = new MemoryFs();
    const first = await openWithHost(fs);
    await threeRuns(first);
    await first.close();
    const live = l0(fs);
    for (const path of ["l0/crashed-flush.sst", "l1/c9.0-100.sst"]) {
      const w = await fs.create(path);
      await w.write(utf("orphan"));
      await w.finish();
    }

    const db = await openWithHost(fs);
    await db.ingest();
    expect(fs.publishedPaths().filter((p) => /^l\d+\//.test(p)).sort()).toEqual([...live].sort());
    for (let i = 0; i < 3; i++) expect(dec.decode((await db.get(utf(`k${i}`)))!)).toBe(`v${i}`);
    await db.close();
  });
});

type Node = FakeDir | Uint8Array;

class FakeDir {
  readonly children = new Map<string, Node>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, (child = new FakeDir()));
    if (!(child instanceof FakeDir)) throw new DOMException(name, "NotFoundError");
    return child;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.children.has(name) && opts?.create) this.children.set(name, new Uint8Array());
    if (!(this.children.get(name) instanceof Uint8Array)) throw new DOMException(name, "NotFoundError");
    return {
      getFile: async () => {
        const bytes = this.children.get(name);
        if (!(bytes instanceof Uint8Array)) throw new DOMException(name, "NotFoundError");
        return new File([bytes], name);
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (c: Uint8Array) => void chunks.push(c),
          close: async () => void this.children.set(name, new Uint8Array(await new Blob(chunks).arrayBuffer())),
          abort: async () => undefined,
        };
      },
    };
  }
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException(name, "NotFoundError");
  }
  async *entries(): AsyncIterableIterator<[string, unknown]> {
    yield* this.children.entries();
  }
}

let browserDbs = 0;
const fsKinds: [string, () => AsyncFs][] = [
  ["MemoryFs", () => new MemoryFs()],
  [
    "BrowserFs",
    () =>
      new BrowserFs(
        new FakeDir() as unknown as FileSystemDirectoryHandle,
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
