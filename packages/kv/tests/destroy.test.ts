import { afterEach, describe, expect, it } from "vitest";
import { CorruptDatabaseError, type ChangeEvent, type Db } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  type AsyncFs,
  createLocalIngestClient,
  destroyHarnessDb,
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
  const options = { name: NAME, fs, ingest: client, maxWalBytes: 1 << 30 };
  const open = async () => {
    const db = await openHarnessDb(options);
    opened.push(db);
    return db;
  };
  return { fs, open, destroy: () => destroyHarnessDb(options) };
}

async function keys(db: Db): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of db.range()) out.push(dec.decode(key));
  return out;
}

async function fill(db: Db, prefix: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await db.put(enc.encode(`${prefix}-${i}`), enc.encode("x"));
  await ingest(db);
}

describe("dangerousDestroy", () => {
  it("removes rows in runs and in the WAL, removes every file, and keeps the handle usable", async () => {
    const { fs, open } = storage();
    const db = await open();
    await fill(db, "run", 50);
    await db.put(enc.encode("wal-only"), enc.encode("y"));
    expect(fs.publishedPaths().length).toBeGreaterThan(0);

    await db.dangerousDestroy();

    expect(fs.publishedPaths()).toEqual([]);
    expect(await db.get(enc.encode("wal-only"))).toBeUndefined();
    expect(await keys(db)).toEqual([]);
    await db.put(enc.encode("new"), enc.encode("1"));
    expect(await keys(db)).toEqual(["new"]);
    expect(await keys(await open())).toEqual(["new"]);
  });

  it("empties the other handles, which keep reading and writing", async () => {
    const { open } = storage();
    const a = await open();
    const b = await open();
    await fill(a, "old", 20);
    await b.sync();
    const events: ChangeEvent["kind"][] = [];
    b.changes((event) => events.push(event.kind));

    await a.dangerousDestroy();
    await b.sync();

    expect(await keys(b)).toEqual([]);
    expect(events).toContain("gap");
    await b.put(enc.encode("after"), enc.encode("1"));
    await a.sync();
    expect(await keys(a)).toEqual(["after"]);
  });

  it("keeps the runs a view in another tab reads, and removes them once it ends", async () => {
    const { fs, open } = storage();
    const a = await open();
    const b = await open();
    await fill(a, "old", 20);
    await b.sync();
    const runs = fs.publishedPaths().filter((path) => !path.startsWith("m/"));

    await b.view(async (snap) => {
      await a.dangerousDestroy();
      expect(fs.publishedPaths()).toEqual(runs);
      expect(dec.decode(await snap.get(enc.encode("old-3")))).toBe("x");
    });
    await b.sync();
    await ingest(b);

    expect(fs.publishedPaths()).toEqual([]);
  });

  it("empties the database when removing its files fails, and removes them at a later flush", async () => {
    let failing = true;
    const { fs, open } = storage((inner) => ({
      read: (path, offset, length) => inner.read(path, offset, length),
      open: (path) => inner.open(path),
      list: (dir) => inner.list(dir),
      remove: async (path) => {
        if (failing) throw new Error("disk gone");
        return inner.remove(path);
      },
      removeUnlessOpen: async (path) => {
        if (failing) throw new Error("disk gone");
        return inner.removeUnlessOpen(path);
      },
      create: (path) => inner.create(path),
    }));
    const a = await open();
    await fill(a, "k", 20);
    await a.put(enc.encode("wal-only"), enc.encode("y"));

    await a.dangerousDestroy();

    expect(await keys(a)).toEqual([]);
    expect(fs.publishedPaths().length).toBeGreaterThan(0);
    failing = false;
    await a.put(enc.encode("new"), enc.encode("1"));
    await ingest(a);
    expect(await keys(await open())).toEqual(["new"]);
    expect(fs.publishedPaths()).toHaveLength(2);
  });
});

describe("destroyDb", () => {
  it("empties a database that no longer opens", async () => {
    const { fs, open, destroy } = storage();
    const db = await open();
    await fill(db, "k", 20);
    await db.close();
    const manifest = fs.publishedPaths().find((path) => path.startsWith("m/"))!;
    await fs.remove(manifest);
    const garbage = await fs.create(manifest);
    await garbage.write(enc.encode("not a manifest"));
    await garbage.finish();
    await expect(open()).rejects.toBeInstanceOf(CorruptDatabaseError);

    await destroy();

    const reopened = await open();
    expect(await keys(reopened)).toEqual([]);
    expect(fs.publishedPaths()).toEqual([]);
  });
});
