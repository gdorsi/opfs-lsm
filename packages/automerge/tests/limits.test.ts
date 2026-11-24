import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConstraintError } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `am${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

test("a key with a segment past 65,535 bytes rejects ConstraintError, as any key over 8 KiB does", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  t.after(() => storage.close?.());
  for (const key of [["x".repeat(65_536)], ["doc", "x".repeat(70_000)]]) {
    await assert.rejects(storage.save(key, Uint8Array.of(1)), ConstraintError, `segment of ${key.at(-1)!.length} bytes`);
  }
  await storage.save(["sibling"], Uint8Array.of(2));
  assert.deepEqual(await storage.load(["sibling"]), Uint8Array.of(2));
});
