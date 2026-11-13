import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import { memoryStorage } from "../src/persistence/index.ts";

const put = (doc: Y.Doc, key: string, value: number, origin?: unknown) =>
  doc.transact(() => doc.getMap("m").set(key, value), origin);

describe("memoryStorage", () => {
  test("attach loads what an earlier attach stored, with an origin of its own", async () => {
    const storage = memoryStorage();
    const first = new Y.Doc();
    await storage.attach("d", first);
    put(first, "a", 1);
    put(first, "b", 2);

    const second = new Y.Doc();
    const origins: unknown[] = [];
    second.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
    await storage.attach("d", second);
    assert.deepEqual(second.getMap("m").toJSON(), { a: 1, b: 2 });
    assert.equal(origins.length, 1);
    assert.notEqual(origins[0], null);
  });

  test("stores every later update once, whatever its origin", async () => {
    const storage = memoryStorage();
    const doc = new Y.Doc();
    await storage.attach("d", doc);
    put(doc, "local", 1);
    put(doc, "remote", 2, "peer");
    assert.equal(storage.updates.get("d")!.length, 2);
  });

  test("keeps documents apart", async () => {
    const storage = memoryStorage();
    const [a, b] = [new Y.Doc(), new Y.Doc()];
    await storage.attach("a", a);
    await storage.attach("b", b);
    put(a, "x", 1);
    const again = new Y.Doc();
    await storage.attach("b", again);
    assert.deepEqual(again.getMap("m").toJSON(), {});
  });

  test("detach stops storing", async () => {
    const storage = memoryStorage();
    const doc = new Y.Doc();
    const binding = await storage.attach("d", doc);
    put(doc, "a", 1);
    await binding.detach();
    put(doc, "b", 2);
    assert.equal(storage.updates.get("d")!.length, 1);
  });

  test("clear deletes the stored updates, stops storing, and can be repeated", async () => {
    const storage = memoryStorage();
    const doc = new Y.Doc();
    const binding = await storage.attach("d", doc);
    put(doc, "a", 1);
    await binding.clear();
    await binding.clear();
    put(doc, "b", 2);
    const again = new Y.Doc();
    await storage.attach("d", again);
    assert.deepEqual(again.getMap("m").toJSON(), {});
  });
});
