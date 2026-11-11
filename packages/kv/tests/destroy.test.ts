import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosedError, type Db } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  type AsyncFs,
  createLocalIngestClient,
  ingest,
  openHarnessDb,
} from "../src/testing.js";

const NAME = "destroy";
const enc = new TextEncoder();
const dec = new TextDecoder();
const opened: Db[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

function storage(hostFs?: (fs: MemoryFs) => AsyncFs) {
  const fs = new MemoryFs();
  const client = createLocalIngestClient(new EngineHost(() => hostFs?.(fs) ?? fs));
  const open = async () => {
    const db = await openHarnessDb({ name: NAME, fs, ingest: client, maxWalBytes: 1 << 30 });
    opened.push(db);
    return db;
  };
  return { fs, open };
}

async function keys(db: Db): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of db.range()) out.push(dec.decode(key));
  return out;
}

describe("dangerousDestroy", () => {
  it("removes rows in runs and in the WAL, and reopens empty", async () => {
    const { fs, open } = storage();
    const db = await open();
    for (let i = 0; i < 50; i++) await db.put(enc.encode(`run-${i}`), enc.encode("x"));
    await ingest(db);
    await db.put(enc.encode("wal-only"), enc.encode("y"));
    expect(fs.publishedPaths().length).toBeGreaterThan(0);

    await db.dangerousDestroy();

    expect(fs.publishedPaths()).toEqual([]);
    await expect(db.get(enc.encode("wal-only"))).rejects.toBeInstanceOf(ClosedError);
    expect(await keys(await open())).toEqual([]);
  });

  it("closes the other handles on the database", async () => {
    const { open } = storage();
    const a = await open();
    const b = await open();
    await a.put(enc.encode("k"), enc.encode("v"));
    const closed = new Promise<void>((resolve) =>
      b.changes((event) => {
        if (event.kind === "closed") resolve();
      }),
    );

    await a.dangerousDestroy();

    await closed;
    await expect(b.get(enc.encode("k"))).rejects.toBeInstanceOf(ClosedError);
  });

  it("leaves the host able to flush and read a new database under the same name", async () => {
    const { open } = storage();
    const before = await open();
    for (let i = 0; i < 20; i++) await before.put(enc.encode(`old-${i}`), enc.encode("x"));
    await ingest(before);
    await before.dangerousDestroy();

    const after = await open();
    await after.put(enc.encode("new"), enc.encode("1"));
    await ingest(after);
    await after.close();

    expect(await keys(await open())).toEqual(["new"]);
  });

  it("empties the database when removing its files fails, and closes every handle", async () => {
    let failing = true;
    const { open } = storage((fs) => ({
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      removeTree: async (path) => {
        if (failing && path !== "m") throw new Error("disk gone");
        await fs.removeTree(path);
      },
    }));
    const a = await open();
    const b = await open();
    for (let i = 0; i < 20; i++) await a.put(enc.encode(`k-${i}`), enc.encode("x"));
    await ingest(a);
    await a.put(enc.encode("wal-only"), enc.encode("y"));

    await expect(a.dangerousDestroy()).rejects.toThrow("disk gone");

    await expect(a.get(enc.encode("wal-only"))).rejects.toBeInstanceOf(ClosedError);
    await vi.waitFor(() => expect(b.get(enc.encode("wal-only"))).rejects.toBeInstanceOf(ClosedError));
    failing = false;
    const reopened = await open();
    expect(await keys(reopened)).toEqual([]);
    await reopened.put(enc.encode("new"), enc.encode("1"));
    await ingest(reopened);
    expect(await keys(reopened)).toEqual(["new"]);
  });
});
