/**
 * A connection closes when another context's upgrade asks it to, which is
 * how `destroyDb` fences a database. `beforeClose` runs first: the
 * connection stays open, and the upgrade waits, until what it returns
 * settles. With no hook the connection closes inside the event.
 */
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/idb/wal.js";

const NAME = "wal-before-close";
const create = (db: IDBDatabase) => void db.createObjectStore("s");

afterEach(
  () =>
    new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }),
);

/** Whether `db` still takes a transaction. A closed connection refuses one. */
function takesTransactions(db: IDBDatabase): boolean {
  try {
    db.transaction("s");
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a WAL connection that another context's upgrade asks to close", () => {
  it.each([
    ["no hook", {}],
    ["a hook that returns nothing", { beforeClose: () => undefined }],
  ])("with %s, closes inside the event", async (_, hook) => {
    const order: string[] = [];
    const db = (await openDatabase(NAME, { create, ...hook, onAskedToClose: () => order.push("asked to close") }))!;
    // fake-indexeddb dispatches only its own events, so the event is one of its class.
    const versionchange = await new Promise<Event>((resolve) => {
      const req = indexedDB.open(`${NAME}-event`);
      req.onsuccess = (ev) => {
        req.result.close();
        resolve(new (ev.constructor as new (type: string) => Event)("versionchange"));
      };
    });

    db.dispatchEvent(versionchange);

    expect({ open: takesTransactions(db), order }).toEqual({ open: false, order: ["asked to close"] });
  });

  it.each(["resolves", "rejects"] as const)("with a hook, stays open and holds the upgrade until what the hook returned %s", async (how) => {
    const order: string[] = [];
    let settle!: () => void;
    const db = (await openDatabase(NAME, {
      create,
      beforeClose: () => {
        order.push("hook ran");
        return new Promise<void>((resolve, reject) => (settle = how === "resolves" ? resolve : () => reject(new Error("hook failed"))));
      },
      onAskedToClose: () => order.push("asked to close"),
    }))!;

    const upgrade = openDatabase(NAME, { version: db.version + 1 }).then((upgraded) => {
      order.push("upgraded");
      upgraded!.close();
    });
    // Long enough for the upgrade to run, had the connection closed.
    await pause(50);
    expect({ open: takesTransactions(db), order }).toEqual({ open: true, order: ["hook ran"] });

    settle();
    await upgrade;
    expect({ open: takesTransactions(db), order }).toEqual({ open: false, order: ["hook ran", "asked to close", "upgraded"] });
  });
});
