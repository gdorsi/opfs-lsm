import assert from "node:assert/strict";
import { test } from "node:test";
import { Repo } from "@automerge/automerge-repo";
import { ConstraintError, noStorage, openDb } from "@opfs-lsm/kv";
import { kvStorage } from "../src/index.ts";

type Doc = { text: string };

const db = await openDb({ name: "automerge-no-storage" }).catch(noStorage);

test("the open gives no db in Node", () => {
  assert.equal(db, undefined);
});

test("a document the Repo evicts and finds again keeps its content", async () => {
  const repo = new Repo({ storage: kvStorage(db), network: [], isEphemeral: true });
  try {
    const handle = repo.create<Doc>({ text: "" });
    handle.change((d) => {
      d.text = "kept";
    });
    await repo.flush();
    await repo.removeFromCache(handle.documentId);

    const again = await repo.find<Doc>(handle.url);
    assert.equal(again.doc().text, "kept");
  } finally {
    await repo.shutdown();
  }
});

test("a key segment past 65,535 bytes rejects ConstraintError, as with a db", async () => {
  const storage = kvStorage(db);
  await assert.rejects(storage.save(["x".repeat(65_536)], Uint8Array.of(1)), ConstraintError);
});
