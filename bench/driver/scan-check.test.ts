import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { KvStore } from "../core/families.ts";
import type { PhaseContext } from "../core/types.ts";
import { CorrectnessError, createModel } from "../page/model.ts";
import { kvParams, scan } from "../workloads/kv-lib.ts";

/** A model with ids 0 to 9 written and id 3 deleted. */
function setup() {
  const model = createModel({ ...kvParams("tiny"), seed: 1 });
  for (let id = 0; id < 10; id++) model.nextValue(id);
  model.remove(3);
  const ctx = {
    model,
    time: (_op: string, _bytes: number, fn: () => Promise<unknown>) => fn(),
    check(ok: boolean, what: string) {
      if (!ok) throw new CorrectnessError(what);
    },
  } as unknown as PhaseContext<"kv">;
  const returning = (ids: number[]) => ({ range: async () => ids.map((id) => model.expected(id)!) }) as unknown as KvStore;
  return { ctx, returning };
}

describe("scan check", () => {
  test("accepts the next live ids, skipping a deleted one", async () => {
    const { ctx, returning } = setup();
    assert.equal(await scan(ctx, returning([1, 2, 4, 5]), 1, 4, "seek"), 4);
  });

  test("accepts a short answer that ends at the last live id", async () => {
    const { ctx, returning } = setup();
    assert.equal(await scan(ctx, returning([8, 9]), 8, 5, "seek"), 2);
  });

  test("rejects a skipped live id", async () => {
    const { ctx, returning } = setup();
    await assert.rejects(scan(ctx, returning([1, 4, 5]), 1, 3, "seek"), /want 2/);
  });

  test("rejects a scan that stops before the limit while live ids remain", async () => {
    const { ctx, returning } = setup();
    await assert.rejects(scan(ctx, returning([1, 2]), 1, 4, "seek"), /stopped after 2 of 4/);
  });

  test("rejects values out of order and a scan that returns more than the limit", async () => {
    const { ctx, returning } = setup();
    await assert.rejects(scan(ctx, returning([2, 1]), 1, 2, "seek"), CorrectnessError);
    await assert.rejects(scan(ctx, returning([1, 2, 4]), 1, 2, "seek"), /3 values for a limit of 2/);
  });
});
