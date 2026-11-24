/**
 * automerge-repo's storage adapter acceptance cases
 * (@automerge/automerge-repo/helpers/tests/storage-adapter-tests), run once on
 * the WAL and once after the rows moved to SST files.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { ingest, openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `am${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const PAYLOAD_A = () => new Uint8Array([0, 1, 127, 99, 154, 235]);
const PAYLOAD_B = () => new Uint8Array([1, 76, 160, 53, 57, 10, 230]);
const PAYLOAD_C = () => new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]);
const LARGE_PAYLOAD = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31 + 7) & 0xff);

const sorted = <T extends { key: string[] }>(chunks: T[]): T[] =>
  chunks.toSorted((a, b) => a.key.join("/").localeCompare(b.key.join("/")));

for (const moved of [false, true]) {
  test(`the automerge-repo storage adapter acceptance cases hold${moved ? " once the rows are in SST files" : ""}`, async (t) => {
    const db = await openHarnessDb({ name: dbName(), forceMemory: true });
    const storage = kvStorage(db);
    t.after(() => storage.close?.());
    const settle = (d: Db) => (moved ? ingest(d) : Promise.resolve());

    assert.equal(await storage.load(["AAAAA", "sync-state", "xxxxx"]), undefined);
    assert.deepEqual(await storage.loadRange(["AAAAA"]), []);

    await storage.save(["storage-adapter-id"], PAYLOAD_A());
    await storage.save(["L", "sync-state", "xxxxx"], LARGE_PAYLOAD);
    await storage.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_A());
    await storage.save(["AAAAA", "snapshot", "yyyyy"], PAYLOAD_B());
    await storage.save(["AAAAA", "sync-state", "zzzzz"], PAYLOAD_C());
    await storage.save(["BBBBB", "sync-state", "zzzzz"], PAYLOAD_B());
    await settle(db);

    assert.deepEqual(await storage.load(["storage-adapter-id"]), PAYLOAD_A());
    assert.deepEqual(await storage.load(["L", "sync-state", "xxxxx"]), LARGE_PAYLOAD);
    assert.deepEqual(
      sorted(await storage.loadRange(["AAAAA"])),
      sorted([
        { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_A() },
        { key: ["AAAAA", "snapshot", "yyyyy"], data: PAYLOAD_B() },
        { key: ["AAAAA", "sync-state", "zzzzz"], data: PAYLOAD_C() },
      ]),
    );
    assert.deepEqual(
      sorted(await storage.loadRange(["AAAAA", "sync-state"])),
      sorted([
        { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_A() },
        { key: ["AAAAA", "sync-state", "zzzzz"], data: PAYLOAD_C() },
      ]),
    );

    await storage.save(["AAAAA", "sync-state", "xxxxx"], PAYLOAD_B());
    await storage.remove(["AAAAA", "snapshot", "yyyyy"]);
    await settle(db);
    assert.equal(await storage.load(["AAAAA", "snapshot", "yyyyy"]), undefined);
    assert.deepEqual(sorted(await storage.loadRange(["AAAAA"])), [
      { key: ["AAAAA", "sync-state", "xxxxx"], data: PAYLOAD_B() },
      { key: ["AAAAA", "sync-state", "zzzzz"], data: PAYLOAD_C() },
    ]);

    await storage.removeRange(["AAAAA", "sync-state"]);
    await settle(db);
    assert.deepEqual(await storage.loadRange(["AAAAA"]), []);
    assert.deepEqual(await storage.loadRange(["BBBBB"]), [{ key: ["BBBBB", "sync-state", "zzzzz"], data: PAYLOAD_B() }]);
  });
}
