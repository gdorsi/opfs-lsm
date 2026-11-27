/**
 * design.md, "Change events": a handle whose WAL connection the browser
 * closes reports `closed` with reason "destroyed". Clearing site data, the
 * `Clear-Site-Data` header or a damaged store closes each connection by
 * force: the connection closes and `close` fires at the `IDBDatabase`, with
 * no `versionchange` first (IndexedDB 3.0, "close a database connection",
 * forced flag). The test does both steps by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClosedError, type ChangeEvent } from "../src/index.js";
import { dbInternals } from "../src/db.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "forced-close";
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

function wipe(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => __resetMemoryFsForTests(NAME));

/** fake-indexeddb dispatches only its own events, so take their class from one it fired. */
function eventClass(): Promise<new (type: string) => Event> {
  return new Promise((resolve) => {
    const req = indexedDB.open(`${NAME}-event`);
    req.onsuccess = (ev) => {
      req.result.close();
      resolve(ev.constructor as new (type: string) => Event);
    };
  });
}

const outcome = (call: Promise<unknown>) =>
  call.then(
    () => "resolved",
    (err: unknown) => (err instanceof ClosedError ? "ClosedError" : err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
  );

describe("a handle whose IndexedDB connection the browser closes by force", () => {
  it("closes, with a `closed` event, and every call rejects with ClosedError", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, maxWalBytes: 1 << 30 });
    await db.put(utf("k"), utf("v"));
    const events: ChangeEvent[] = [];
    db.changes((e) => events.push(e));

    const connection = dbInternals(db).wal.db;
    connection.close();
    connection.dispatchEvent(new (await eventClass())("close"));

    const calls = {
      put: await outcome(db.put(utf("k"), utf("w"))),
      sync: await outcome(db.sync()),
      update: await outcome(db.update([utf("k")], () => undefined)),
      get: await outcome(db.get(utf("k"))),
    };
    const heard = events.filter((e) => e.kind === "closed");
    await db.close();

    expect({ heard, calls }).toEqual({
      heard: [{ kind: "closed", reason: "destroyed" }],
      calls: { put: "ClosedError", sync: "ClosedError", update: "ClosedError", get: "ClosedError" },
    });
  });
});
