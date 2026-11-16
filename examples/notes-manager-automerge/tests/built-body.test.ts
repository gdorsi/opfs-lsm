import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageId } from "../src/model/bodies.ts";
import { openNotes } from "../src/model/notes.ts";
import { memoryStorage } from "../src/storage/memory.ts";
import { builtBody } from "../src/testing/built-body.ts";
import { referenceBody } from "../src/testing/reference.ts";

test("a built body, pasted in one edit, equals its own spans and the oracle's", async (t) => {
  const doc = builtBody(5_000);
  const notes = await openNotes({ storage: memoryStorage() });
  t.after(() => notes.close());
  const body = await notes.bodies.open(newPageId());
  body.edit(doc.edits);
  assert.deepEqual(body.spans(), doc.spans);

  const oracle = referenceBody();
  oracle.edit(doc.edits);
  assert.deepEqual(oracle.spans(), doc.spans);
  assert.equal(oracle.length(), doc.end);
  assert.ok(doc.spans.some((s) => s.type === "block" && s.block.type === "heading"));
  assert.ok(doc.spans.some((s) => s.type === "text" && s.marks.bold));
  assert.ok(doc.spans.some((s) => s.type === "text" && s.marks.link));
});
