import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDbName } from "../src/check.js";
import { codeOfError } from "../src/errors.js";
import type { Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import { BrowserFs } from "../src/opfs/browser-fs.js";
import { createLocalIngestClient, EngineHost, ingest, openHarnessDb, settle } from "../src/testing.js";
import { fakeOpfs, type FakeDir } from "./fake-opfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const PATH = "l0/1-2.sst";
const STAGED = `${PATH}.crswap`;

let n = 0;

/** A database folder in a browser whose files have a sync access handle and no `createWritable()`. */
function folder(): { dir: FakeDir; fs: BrowserFs; name: string } {
  const dir = fakeOpfs("sync");
  const name = `staged-${++n}`;
  return { dir, name, fs: new BrowserFs(dir as unknown as FileSystemDirectoryHandle, checkDbName(name), "staged") };
}

async function text(fs: BrowserFs, path: string): Promise<string | undefined> {
  const bytes = await fs.read(path, 0, Number.POSITIVE_INFINITY);
  return bytes && dec.decode(bytes);
}

/** A staged file as a host leaves it when it dies mid-write. */
async function leave(dir: FakeDir, path: string, body: string): Promise<void> {
  const parts = path.split("/");
  const parent = await dir.getDirectoryHandle(parts[0]!, { create: true });
  const handle = (await parent.getFileHandle(parts[1]!, { create: true })) as unknown as {
    createSyncAccessHandle(): Promise<{ write(bytes: Uint8Array, at: { at: number }): number; close(): void }>;
  };
  const access = await handle.createSyncAccessHandle();
  access.write(utf(body), { at: 0 });
  access.close();
}

describe("a file written where OPFS has no createWritable", () => {
  it("appears under its name with every byte at finish, and not before", async () => {
    const { dir, fs } = folder();
    const writer = await fs.create(PATH);
    await writer.write(utf("hello "));
    await writer.write(utf("world"));
    expect(await text(fs, PATH)).toBeUndefined();

    await writer.finish();
    expect(await text(fs, PATH)).toBe("hello world");
    expect(dir.files()).toEqual({ [PATH]: 11 });
    expect(dir.origin.open).toBe(0);
  });

  it("leaves nothing after abort", async () => {
    const { dir, fs } = folder();
    const writer = await fs.create(PATH);
    await writer.write(utf("half"));
    await writer.abort();
    expect(dir.files()).toEqual({});
    expect(dir.origin.open).toBe(0);
    await expect(writer.write(utf("more"))).rejects.toThrow("write after finish/abort");
  });

  it("replaces the file published under the name, whole", async () => {
    const { dir, fs } = folder();
    for (const body of ["the first, longer body", "second"]) {
      const writer = await fs.create(PATH);
      await writer.write(utf(body));
      expect(await text(fs, PATH)).toBe(body === "second" ? "the first, longer body" : undefined);
      await writer.finish();
    }
    expect(await text(fs, PATH)).toBe("second");
    expect(dir.files()).toEqual({ [PATH]: 6 });
  });

  it("writes over a staged file that a crash left", async () => {
    const { dir, fs } = folder();
    await leave(dir, STAGED, "what a dead host staged, longer than the next write");
    const writer = await fs.create(PATH);
    await writer.write(utf("fresh"));
    await writer.finish();
    expect(await text(fs, PATH)).toBe("fresh");
    expect(dir.files()).toEqual({ [PATH]: 5 });
  });

  it.each([
    ["throws QuotaExceededError", false],
    ["writes part of the bytes", true],
  ])("fails as a refused createWritable write does when the browser %s, and the path can be written again", async (_how, short) => {
    const { dir, fs } = folder();
    dir.origin.short = short;
    dir.origin.free = 8;
    const refused = await fs.create(PATH);
    await refused.write(utf("fits"));
    const err = await refused.write(utf("does not fit")).catch((e: unknown) => e);
    expect(codeOfError(err)).toBe("quota");
    expect(dir.files()).toEqual({});
    expect(dir.origin.open).toBe(0);
    expect(dir.origin.free).toBe(8);

    dir.origin.free = 64;
    const again = await fs.create(PATH);
    await again.write(utf("fits now"));
    await again.finish();
    expect(await text(fs, PATH)).toBe("fits now");
  });

  it("removes the staged file when the handle is refused", async () => {
    const dir = fakeOpfs("throws");
    const fs = new BrowserFs(dir as unknown as FileSystemDirectoryHandle, checkDbName("staged-refused"), "staged");
    await expect(fs.create(PATH)).rejects.toThrow("no sync access handle in this context");
    expect(dir.files()).toEqual({});
  });
});

describe("a host that stages its files", () => {
  const KiB = 1024;
  const RESERVE = 64 * KiB;
  const opened: Db[] = [];
  const key = (i: number) => utf(`k${String(i).padStart(5, "0")}`);

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
    vi.restoreAllMocks();
  });

  async function open(at: { fs: BrowserFs; name: string }, reserveBytes = 0): Promise<Db> {
    const db = await openHarnessDb({
      name: at.name,
      fs: at.fs,
      ingest: createLocalIngestClient(new EngineHost(() => at.fs)),
      maxWalBytes: 1 << 30,
      reserveBytes,
    });
    opened.push(db);
    return db;
  }

  it("flushes, compacts and keeps a reserve, and a fresh host reads every row", async () => {
    const at = folder();
    const db = await open(at, RESERVE);
    for (let round = 0; round < 6; round++) {
      await db.batch((tx) => {
        for (let i = 0; i < 50; i++) tx.put(key(round * 50 + i), utf(`v${round}`));
      });
      await ingest(db);
    }
    await db.delete(key(7));
    await settle(db);
    const files = at.dir.files();
    expect(Object.keys(files).some((path) => /^l[1-9]\//.test(path))).toBe(true);
    expect(Object.keys(files).filter((path) => path.endsWith(".crswap"))).toEqual([]);
    expect(files[RESERVE_PATH]).toBe(RESERVE);
    expect(at.dir.origin.open).toBe(0);
    await db.close();
    opened.length = 0;

    const again = await open(at);
    expect(await again.count()).toBe(299);
    expect(await again.get(key(7))).toBeUndefined();
    expect(dec.decode(await again.get(key(299)))).toBe("v5");
  });

  it.each([
    ["throws QuotaExceededError", false],
    ["writes part of the bytes", true],
  ])("lands a flush on the released reserve when the browser %s", async (_how, short) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const at = folder();
    const { origin } = at.dir;
    origin.short = short;
    const db = await open(at, RESERVE);
    let calls = 0;
    db.onStorageFull(async () => {
      calls += 1;
      origin.free = Number.POSITIVE_INFINITY;
    });
    await db.put(key(0), utf("first"));
    await settle(db);
    expect(at.dir.files()[RESERVE_PATH]).toBe(RESERVE);

    origin.free = 512;
    await db.batch((tx) => {
      for (let i = 1; i <= 8; i++) tx.put(key(i), new Uint8Array(KiB).fill(i));
    });
    const { generation } = await ingest(db);
    expect(generation).toBeGreaterThan(1);
    await vi.waitFor(() => expect(at.dir.files()[RESERVE_PATH]).toBe(RESERVE), { timeout: 5000 });
    expect(calls).toBe(1);
    expect(origin.open).toBe(0);
    await db.close();
    opened.length = 0;

    const again = await open(at);
    expect(await again.count()).toBe(9);
  });
});
