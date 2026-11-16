import * as A from "@automerge/automerge";
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST_SEED, SEED } from "../src/model/seed.ts";

test("the body seed regenerates byte for byte", () => {
  const regenerated = A.save(
    A.change(A.init<{ text: string }>({ actor: "00" }), { time: 0 }, (d) => {
      d.text = "";
      A.splitBlock(d, ["text"], 0, { type: "paragraph", parents: [], attrs: {} });
    }),
  );
  assert.deepEqual(regenerated, SEED);
});

test("the list seed regenerates byte for byte", () => {
  const regenerated = A.save(
    A.change(A.init<{ pages: Record<string, never> }>({ actor: "00" }), { time: 0 }, (d) => {
      d.pages = {};
    }),
  );
  assert.deepEqual(regenerated, LIST_SEED);
});
