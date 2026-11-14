import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import { BACKENDS, collectUnhandled, disk } from "../support/disk.ts";

const put = (doc: Y.Doc, key: string, value: number, origin?: unknown) =>
  doc.transact(() => doc.getMap("m").set(key, value), origin);

const json = (doc: Y.Doc) => doc.getMap("m").toJSON();

for (const backend of BACKENDS) {
  describe(`DocStorage contract on ${backend}`, () => {
    const fresh = () => disk(backend);

    test("a doc comes back after detach, with every edit", async () => {
      const { storage } = fresh();
      const first = new Y.Doc();
      const binding = await storage.attach("d", first);
      put(first, "a", 1);
      put(first, "b", 2);
      await binding.detach();

      const second = new Y.Doc();
      await storage.attach("d", second);
      assert.deepEqual(json(second), { a: 1, b: 2 });
    });

    test("attach applies stored updates with an origin that is not the caller's", async () => {
      const { storage } = fresh();
      const first = new Y.Doc();
      const binding = await storage.attach("d", first);
      put(first, "a", 1);
      await binding.detach();

      const second = new Y.Doc();
      const origins: unknown[] = [];
      second.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
      await storage.attach("d", second);
      assert.deepEqual(json(second), { a: 1 });
      assert.ok(origins.length > 0 && origins.every((origin) => origin !== null && origin !== undefined));
    });

    test("every later update is stored, whatever its origin", async () => {
      const { storage } = fresh();
      const first = new Y.Doc();
      const binding = await storage.attach("d", first);
      put(first, "local", 1);
      put(first, "remote", 2, "peer");
      await binding.detach();

      const second = new Y.Doc();
      await storage.attach("d", second);
      assert.deepEqual(json(second), { local: 1, remote: 2 });
    });

    test("an attach does not store what it loaded a second time", async () => {
      const d = fresh();
      const first = new Y.Doc();
      const binding = await d.storage.attach("d", first);
      put(first, "a", 1);
      await binding.detach();

      const second = new Y.Doc();
      const again = await d.storage.attach("d", second);
      put(second, "b", 2);
      await again.detach();

      const third = new Y.Doc();
      await d.storage.attach("d", third);
      assert.deepEqual(json(third), { a: 1, b: 2 });
    });

    test("flush makes every edit so far visible to another reader, with no detach", async () => {
      const { storage } = fresh();
      const writer = new Y.Doc();
      const binding = await storage.attach("d", writer);
      for (let i = 0; i < 20; i++) put(writer, `k${i}`, i);
      await binding.flush();

      const reader = new Y.Doc();
      await storage.attach("d", reader);
      assert.equal(Object.keys(json(reader)).length, 20);
      await binding.detach();
    });

    test("flush with nothing written resolves, and so does a second flush", async () => {
      const { storage } = fresh();
      const binding = await storage.attach("d", new Y.Doc());
      await binding.flush();
      await binding.flush();
      await binding.detach();
    });

    test("detach stores what was written before it without a flush, and stores nothing after", async () => {
      const { storage } = fresh();
      const doc = new Y.Doc();
      const binding = await storage.attach("d", doc);
      put(doc, "before", 1);
      await binding.detach();
      put(doc, "after", 2);
      await binding.detach();
      await binding.flush();

      const again = new Y.Doc();
      await storage.attach("d", again);
      assert.deepEqual(json(again), { before: 1 });
    });

    test("docs are kept apart, including a name that extends another", async () => {
      const { storage } = fresh();
      const [a, ab] = [new Y.Doc(), new Y.Doc()];
      const [ba, bab] = [await storage.attach("a", a), await storage.attach("a/b", ab)];
      put(a, "x", 1);
      put(ab, "y", 2);
      await Promise.all([ba.detach(), bab.detach()]);

      const [again, againAb] = [new Y.Doc(), new Y.Doc()];
      await storage.attach("a", again);
      await storage.attach("a/b", againAb);
      assert.deepEqual(json(again), { x: 1 });
      assert.deepEqual(json(againAb), { y: 2 });
    });

    test("clear removes that doc only, and the disk holds nothing of it once it resolves", async () => {
      const d = fresh();
      const [a, ab, other] = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
      const binding = await d.storage.attach("a", a);
      const sibling = await d.storage.attach("a/b", ab);
      const third = await d.storage.attach("other", other);
      put(a, "x", 1);
      put(ab, "y", 2);
      put(other, "z", 3);
      await Promise.all([sibling.flush(), third.flush()]);

      await binding.clear();
      assert.equal(await d.holds("a"), false);
      assert.equal(await d.holds("a/b"), true);
      assert.equal(await d.holds("other"), true);

      const [gone, kept] = [new Y.Doc(), new Y.Doc()];
      await d.storage.attach("a", gone);
      await d.storage.attach("a/b", kept);
      assert.deepEqual(json(gone), {});
      assert.deepEqual(json(kept), { y: 2 });
      await Promise.all([sibling.detach(), third.detach()]);
    });

    test("clear stops storing, and can be repeated", async () => {
      const d = fresh();
      const doc = new Y.Doc();
      const binding = await d.storage.attach("d", doc);
      put(doc, "a", 1);
      await binding.clear();
      await binding.clear();
      put(doc, "b", 2);
      await binding.flush();
      assert.equal(await d.holds("d"), false);

      const again = new Y.Doc();
      await d.storage.attach("d", again);
      assert.deepEqual(json(again), {});
    });

    test("a doc can be cleared after detach, and written again from scratch", async () => {
      const d = fresh();
      const doc = new Y.Doc();
      const binding = await d.storage.attach("d", doc);
      put(doc, "a", 1);
      await binding.detach();
      await binding.clear();
      assert.equal(await d.holds("d"), false);

      const next = new Y.Doc();
      const fresher = await d.storage.attach("d", next);
      put(next, "b", 2);
      await fresher.detach();
      const last = new Y.Doc();
      await d.storage.attach("d", last);
      assert.deepEqual(json(last), { b: 2 });
    });

    test("two attaches on one doc name, as two tabs are, both store and a third sees both", async () => {
      const { storage } = fresh();
      const [one, two] = [new Y.Doc(), new Y.Doc()];
      const [first, second] = [await storage.attach("d", one), await storage.attach("d", two)];
      put(one, "a", 1);
      put(two, "b", 2);
      await Promise.all([first.detach(), second.detach()]);

      const third = new Y.Doc();
      await storage.attach("d", third);
      assert.deepEqual(json(third), { a: 1, b: 2 });
    });

    test("600 updates come back whole, past the trim size of both libraries", async () => {
      const { storage } = fresh();
      const doc = new Y.Doc();
      const binding = await storage.attach("d", doc);
      for (let i = 0; i < 600; i++) put(doc, `k${i}`, i);
      await binding.detach();

      const again = new Y.Doc();
      const second = await storage.attach("d", again);
      assert.equal(Object.keys(json(again)).length, 600);
      await second.detach();
      const third = new Y.Doc();
      await storage.attach("d", third);
      assert.equal(Object.keys(json(third)).length, 600);
    });

    const failing = backend === "memory" ? { skip: "an in-memory write cannot fail" } : {};
    test("a failed write rejects flush until a flush can store the whole doc again", failing, async (t) => {
      const d = fresh();
      const unhandled = collectUnhandled(t);

      const doc = new Y.Doc();
      const binding = await d.storage.attach("d", doc);
      put(doc, "kept", 1);
      await binding.flush();

      d.failWrites!(true);
      put(doc, "lost", 2);
      await assert.rejects(binding.flush());
      await assert.rejects(binding.flush(), "it keeps rejecting while the repair fails");

      d.failWrites!(false);
      put(doc, "after", 3);
      await binding.flush();
      await binding.flush();
      await binding.detach();

      const again = new Y.Doc();
      await d.storage.attach("d", again);
      assert.deepEqual(json(again), { kept: 1, lost: 2, after: 3 });
      if (backend === "kv") assert.deepEqual(unhandled, []);
    });
  });
}
