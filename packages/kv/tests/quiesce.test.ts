/**
 * `ReadFs.quiesce` is how a tab's fs lets go of what would stop the removal
 * of the database folder: with `syncReads`, the worker's handles on the run
 * files. A handle's close resolves only once it settled, and so does the
 * close of its WAL connection, which `destroyDb` waits for before it removes
 * the folder.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db } from "../src/index.js";
import type { ReadFs } from "../src/opfs/async-fs.js";
import { destroyHarnessDb, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const NAME = "quiesce";
const enc = new TextEncoder();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settles every `quiesce` a test left out, so a test that failed part way leaves no handle its cleanup would wait for. */
const settles: (() => void)[] = [];

/** A folder that says when it is removed, read through an fs whose `quiesce` the test settles. */
function storage() {
  const order: string[] = [];
  class Folder extends MemoryFs {
    override async removeFolder(): Promise<void> {
      order.push("folder removed");
      await super.removeFolder();
    }
  }
  const fs = new Folder();
  let settle = () => {};
  settles.push(() => settle());
  let quiesced: Promise<void> | undefined;
  const reading = (inner: ReadFs): ReadFs => ({
    read: (path, offset, length) => inner.read(path, offset, length),
    open: (path) => inner.open(path),
    list: (dir) => inner.list(dir),
    quiesce: () =>
      (quiesced ??= new Promise<void>((resolve) => {
        order.push("quiesce asked");
        settle = () => {
          order.push("quiesce settled");
          resolve();
        };
      })),
  });
  const options = { name: NAME, fs, maxWalBytes: 1 << 30 };
  return {
    order,
    settle: () => settle(),
    /** A handle with a run on disk, so the folder holds files to remove. */
    async open(): Promise<Db> {
      const db = await openHarnessDb({ ...options, wrapFs: reading });
      await db.put(enc.encode("k"), enc.encode("v"));
      await ingest(db);
      return db;
    },
    destroy: () => destroyHarnessDb(options).then(() => void order.push("destroyed")),
  };
}

afterEach(async () => {
  for (const settle of settles.splice(0)) settle();
  await destroyHarnessDb({ name: NAME, fs: new MemoryFs() });
});

describe("an fs that has something to let go of before its folder can be removed", () => {
  it("close resolves once quiesce settled, and so does a second close", async () => {
    const { order, settle, open } = storage();
    const db = await open();

    const first = db.close().then(() => void order.push("closed"));
    const second = db.close().then(() => void order.push("closed again"));
    await pause(50);
    expect(order).toEqual(["quiesce asked"]);

    settle();
    await Promise.all([first, second]);
    expect(order).toEqual(["quiesce asked", "quiesce settled", "closed", "closed again"]);
  });

  it("destroyDb removes the folder only after the quiesce of a handle it closes settled", async () => {
    const { order, settle, open, destroy } = storage();
    const db = await open();
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));

    const destroying = destroy();
    await pause(50);
    expect({ order, events }).toEqual({ order: ["quiesce asked"], events: [] });

    settle();
    await destroying;
    expect({ order, events }).toEqual({
      order: ["quiesce asked", "quiesce settled", "folder removed", "destroyed"],
      events: [{ kind: "closed", reason: "destroyed" }],
    });
  });

  it("destroyDb removes the folder only after the quiesce of a close in flight settled", async () => {
    const { order, settle, open, destroy } = storage();
    const db = await open();

    const closing = db.close();
    const destroying = destroy();
    await pause(50);
    expect(order).toEqual(["quiesce asked"]);

    settle();
    await Promise.all([closing, destroying]);
    expect(order).toEqual(["quiesce asked", "quiesce settled", "folder removed", "destroyed"]);
  });
});
