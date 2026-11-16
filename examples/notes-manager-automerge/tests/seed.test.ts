import * as A from "@automerge/automerge";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEED } from "../src/model/seed.ts";

test("the seed regenerates byte for byte", () => {
  const regenerated = A.save(
    A.change(A.init<{ text: string }>({ actor: "00" }), { time: 0 }, (d) => {
      d.text = "";
      A.splitBlock(d, ["text"], 0, { type: "paragraph", parents: [], attrs: {} });
    }),
  );
  assert.deepEqual(regenerated, SEED);
});
