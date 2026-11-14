import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Comment } from "../domain/model.ts";
import { openIndexedDbBackend } from "./indexeddb.ts";

const comment = (body: string): Comment => ({ key: "i1/c1", id: "c1", issue_id: "i1", body, username: "ada", created: 1, deleted: false, version: 1 });

test("a tab's transact merges with what another tab stored, even before its broadcast arrives", async () => {
  const name = `linearlite-tabs-${randomUUID()}`;
  const one = await openIndexedDbBackend(name);
  const two = await openIndexedDbBackend(name);
  try {
    await one.transact("comments", [comment("first")], (_, row) => row);
    for (let i = 0; i < 100 && (await two.read("comments", ["c1"]))[0]?.body !== "first"; i++) await new Promise((r) => setTimeout(r, 10));

    await one.transact("comments", [comment("second")], (_, row) => row);
    await two.transact("comments", [{ id: "c1" }], (local) => local && { ...local, deleted: true });

    const fresh = await openIndexedDbBackend(name);
    const [stored] = await fresh.read("comments", ["c1"]);
    await fresh.close();
    assert.deepEqual({ body: stored?.body, deleted: stored?.deleted }, { body: "second", deleted: true }, "neither tab's write is lost");
  } finally {
    await one.close();
    await two.close();
  }
});
