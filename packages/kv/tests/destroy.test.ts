import { afterEach, describe, expect, it } from "vitest";
import { checkDbName } from "../src/check.js";
import { readDestroyed } from "../src/idb/destroyed.js";
import { IdBWal, type WalMeta } from "../src/idb/wal.js";
import { ClosedError, CorruptDatabaseError, type ChangeEvent, type Db } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  type AsyncFs,
  type RemovableFs,
  createLocalIngestClient,
  destroyHarnessDb,
  ingest,
  openHarnessDb,
} from "../src/testing.js";
import { compactHost } from "./compact-host.js";

const NAME = "destroy";
const enc = new TextEncoder();
const dec = new TextDecoder();
const opened: Db[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

function storage(hostFs?: (fs: MemoryFs) => AsyncFs, name = NAME) {
  const fs = new MemoryFs();
  const client = createLocalIngestClient(new EngineHost(() => hostFs?.(fs) ?? fs));
  const options = { name, fs, ingest: client, maxWalBytes: 1 << 30 };
  const open = async () => {
    const db = await openHarnessDb(options);
    opened.push(db);
    return db;
  };
  return { fs, open, destroy: () => destroyHarnessDb(options) };
}

async function walDatabases(): Promise<(string | undefined)[]> {
  return (await indexedDB.databases()).map((info) => info.name);
}

async function walMeta(name: string): Promise<WalMeta> {
  const wal = (await IdBWal.openExisting(checkDbName(name)))!;
  try {
    return await wal.meta();
  } finally {
    wal.close();
  }
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

describe("destroyDb gives the storage back", () => {
  it("leaves no WAL database and no file", async () => {
    const { fs, open, destroy } = storage(undefined, "removed");
    const db = await open();
    await fill(db, "k", 20);
    await db.put(enc.encode("tail"), enc.encode("y"));
    await db.close();

    await destroy();

    expect(await walDatabases()).not.toContain("opfs-lsm-wal/removed");
    expect(fs.publishedPaths()).toEqual([]);
  });

  it("creates nothing for a name never opened", async () => {
    const { destroy } = storage(undefined, "never-opened");

    await destroy();

    expect(await walDatabases()).not.toContain("opfs-lsm-wal/never-opened");
  });
});

describe("destroyDb", () => {
  it("closes every handle on the database, in this tab and others, with reason destroyed", async () => {
    const { open, destroy } = storage(undefined, "closes");
    const a = await open();
    const b = await open();
    await fill(a, "k", 5);
    const events: ChangeEvent[] = [];
    b.changes((event) => events.push(event));

    await destroy();

    expect(events.at(-1)).toEqual({ kind: "closed", reason: "destroyed" });
    await expect(b.put(enc.encode("x"), enc.encode("1"))).rejects.toBeInstanceOf(ClosedError);
    await expect(a.get(enc.encode("k-1"))).rejects.toBeInstanceOf(ClosedError);
    await expect(a.dangerousDestroy()).rejects.toBeInstanceOf(ClosedError);
  });

  it("fails a view's read of a removed file with ClosedError", async () => {
    const mem = new MemoryFs();
    let removed = false;
    const fs: RemovableFs = {
      read: (path, offset, length) => mem.read(path, offset, length),
      open: async (path) => {
        const file = await mem.open(path);
        return (
          file && {
            size: file.size,
            read: (offset, length) => (removed ? Promise.reject(new DOMException(path, "NotFoundError")) : file.read(offset, length)),
            close: () => file.close(),
          }
        );
      },
      list: (dir) => mem.list(dir),
      remove: (path) => mem.remove(path),
      removeUnlessOpen: (path) => mem.removeUnlessOpen(path),
      create: (path) => mem.create(path),
      removeFolder: async () => {
        removed = true;
        await mem.removeFolder();
      },
    };
    const options = { name: "view-gone", fs, ingest: createLocalIngestClient(new EngineHost(() => fs)), maxWalBytes: 1 << 30 };
    const db = await openHarnessDb(options);
    opened.push(db);
    await fill(db, "k", 20);

    await db.view(async (snap) => {
      await destroyHarnessDb(options);
      await expect(snap.get(enc.encode("k-3"))).rejects.toBeInstanceOf(ClosedError);
    });
  });

  it("finishes an append in flight below the head the destroyed row records", async () => {
    const { open, destroy } = storage(undefined, "in-flight");
    const db = await open();
    const put = db.put(enc.encode("late"), enc.encode("1")).catch(() => undefined);

    await destroy();

    const seq = await put;
    const row = await readDestroyed(checkDbName("in-flight"));
    expect(row).toBeDefined();
    if (seq !== undefined) expect(seq).toBeLessThan(row!.head);
  });

  it("starts a database born again under the name past every seq and manifest number the old one used", async () => {
    const name = "reborn";
    const { open, destroy } = storage(undefined, name);
    const db = await open();
    await fill(db, "k", 20);
    await db.put(enc.encode("tail"), enc.encode("y"));
    const before = await walMeta(name);
    await db.close();

    await destroy();

    const row = (await readDestroyed(checkDbName(name)))!;
    expect(row.head).toBeGreaterThan(before.head);
    expect(row.top).toBeGreaterThanOrEqual(before.generation!);
    const again = await open();
    expect(await keys(again)).toEqual([]);
    expect(await readDestroyed(checkDbName(name))).toBeUndefined();
    expect(await again.put(enc.encode("new"), enc.encode("1"))).toBeGreaterThan(before.head);
    await ingest(again);
    const after = await walMeta(name);
    expect(after.ingestedThrough).toBeGreaterThan(before.head);
    expect(after.generation).toBeGreaterThan(row.top);
    expect(await keys(again)).toEqual(["new"]);
  });

  it("brings no row back when a power loss keeps the WAL delete and loses every remove", async () => {
    const { fs, open, destroy } = storage(undefined, "power-loss");
    const db = await open();
    await fill(db, "k", 20);
    await db.put(enc.encode("tail"), enc.encode("y"));
    await ingest(db);
    await db.close();
    const files = new Map<string, Uint8Array>();
    for (const path of fs.publishedPaths()) files.set(path, (await fs.read(path, 0, Number.POSITIVE_INFINITY))!);

    await destroy();
    // OPFS lost the removes; IndexedDB kept the row and the delete.
    for (const [path, bytes] of files) {
      const w = await fs.create(path);
      await w.write(bytes);
      await w.finish();
    }

    expect(await walDatabases()).not.toContain("opfs-lsm-wal/power-loss");
    const again = await open();
    expect(await keys(again)).toEqual([]);
    await again.put(enc.encode("new"), enc.encode("1"));
    await ingest(again);
    expect(await keys(again)).toEqual(["new"]);
    expect(await keys(await open())).toEqual(["new"]);
    expect(fs.publishedPaths().filter((path) => files.has(path))).toEqual([]);
  });

  it("leaves the host nothing to recreate", async () => {
    const name = "host-gone";
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const options = { name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 };
    const db = await openHarnessDb(options);
    opened.push(db);
    await fill(db, "k", 20);

    await destroyHarnessDb(options);

    await expect(host.ingest(name, true)).rejects.toBeInstanceOf(ClosedError);
    await expect(compactHost(host, name)).rejects.toBeInstanceOf(ClosedError);
    await expect(host.stats(name)).rejects.toBeInstanceOf(ClosedError);
    await expect(host.destroy(name)).rejects.toBeInstanceOf(ClosedError);
    host.watch(name, { maxWalBytes: 1, compactionMemoryBytes: 32 << 20, maxBytes: 1 });
    host.unwatch(name);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await walDatabases()).not.toContain(`opfs-lsm-wal/${name}`);
    expect(fs.publishedPaths()).toEqual([]);
  });

  it("closes an open that started first, and empties one that starts during the destroy", async () => {
    const { open, destroy } = storage(undefined, "race");
    const db = await open();
    await fill(db, "k", 20);
    await db.close();

    const events: ChangeEvent[] = [];
    const first = open().then((handle) => {
      handle.changes((event) => events.push(event));
      return handle;
    });
    const removing = destroy();
    const second = open();
    const [early, , late] = await Promise.all([first, removing, second]);

    expect(events.at(-1)).toEqual({ kind: "closed", reason: "destroyed" });
    await expect(early.get(enc.encode("k-1"))).rejects.toBeInstanceOf(ClosedError);
    expect(await keys(late)).toEqual([]);
    await late.put(enc.encode("new"), enc.encode("1"));
    expect(await keys(late)).toEqual(["new"]);
  });
});
