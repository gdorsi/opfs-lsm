/**
 * README "Errors": "ConstraintError: a name, key, value, batch or range is
 * invalid or over a limit." Untyped JavaScript can pass a name of the wrong
 * type, and the open refuses it before it opens anything.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConstraintError, type Db } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "name-type";

function wipe(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

const opened: { db: Db; name: string }[] = [];
afterEach(async () => {
  for (const { db, name } of opened.splice(0)) {
    await db.close();
    await wipe(name);
    __resetMemoryFsForTests(name);
  }
});

const openFails = (options: Record<string, unknown>) =>
  openHarnessDb({ name: NAME, forceMemory: true, ...options }).then(
    (db) => {
      opened.push({ db, name: String(options.name ?? NAME) });
      return undefined;
    },
    (err: unknown) => err,
  );

describe("openDb refuses a name that is not a string with ConstraintError", () => {
  // `RegExp.test` would turn each into a name that matches: "undefined", "null", "123", "abc", "true".
  for (const name of [undefined, null, 123, ["abc"], true]) {
    it(`name ${JSON.stringify(name) ?? "undefined"}`, async () => {
      expect(await openFails({ name })).toBeInstanceOf(ConstraintError);
    });
  }
});
