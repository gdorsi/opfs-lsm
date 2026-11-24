/**
 * An `update` whose IndexedDB transaction the browser aborts while it reads
 * the WAL tail rejects, and must leave no second rejection behind. A browser
 * aborts a transaction in flight when it closes the connection by force
 * (cleared site data, a damaged store), and a page reports every unhandled
 * rejection to `window.onunhandledrejection`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "update-abort-unhandled";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

function wipe(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  __resetMemoryFsForTests(NAME);
});

/** Abort the next readwrite transaction over `wal` and `meta`, the one an `update` reads the tail in, once its reads are issued. */
function abortNextUpdateTransaction(): { aborted: number } {
  const count = { aborted: 0 };
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.apply(this, args as Parameters<IDBDatabase["transaction"]>);
    const stores = [...tx.objectStoreNames];
    if (count.aborted === 0 && tx.mode === "readwrite" && stores.includes("meta") && stores.includes("wal")) {
      count.aborted += 1;
      queueMicrotask(() => tx.abort());
    }
    return tx;
  });
  return count;
}

describe("an update whose transaction the browser aborts", () => {
  it("rejects once: no unhandled rejection follows, and the next update runs", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, maxWalBytes: 1 << 30 });
    await db.put(utf("n"), utf("1"));
    const count = abortNextUpdateTransaction();

    // A body that writes nothing runs in the transaction.
    const failed = await db.update([utf("n")], () => undefined).then(
      () => undefined,
      (err: unknown) => err,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(count.aborted).toBe(1);
    expect(failed, "the update rejects").toBeDefined();
    expect(await db.update([utf("n")], ([n]) => n && dec.decode(n))).toBe("1");
    expect(unhandled, "rejections nothing handled").toEqual([]);
    await db.close();
  });
});
