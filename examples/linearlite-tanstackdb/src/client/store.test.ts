import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDocStore, type DocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { schema } from "./store.ts";

const sorted = (...on: string[]) => ({ kind: "sorted", on, unique: false });

const EXPECTED = {
  issues: {
    byCreated: sorted("deleted", "created"),
    byTitle: sorted("deleted", "title"),
    byPriority: sorted("deleted", "priority", "priorityOrder"),
    byStatus: sorted("deleted", "status", "statusOrder"),
    search: { kind: "text", on: ["deleted", "modified"], unique: false, text: "title" },
    pending: sorted("pending"),
  },
  bodies: { pending: sorted("pending") },
  comments: { byIssue: sorted("issue_id"), pending: sorted("pending") },
  sync: {},
};

let kv: Db;
let docs: DocStore<typeof schema>;
before(async () => {
  kv = await openHarnessDb({ name: `linearlite-store-${process.pid}`, forceMemory: true });
  docs = await openDocStore(kv, schema);
});
after(() => kv.close());

describe("schema", () => {
  it("declares the indexes DESIGN.md, 'Indexes' lists, at the stored format", () => {
    assert.equal(schema.version, 4);
    for (const [name, indexes] of Object.entries(EXPECTED)) {
      assert.deepEqual(Object.fromEntries(docs.collection(name as keyof typeof EXPECTED).indexes), indexes, name);
    }
  });
});
