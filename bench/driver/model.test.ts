import assert from "node:assert/strict";
import { test } from "node:test";
import { createModel } from "../page/model.ts";
import { kvParams } from "../workloads/kv-lib.ts";

const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

test("a miss key sorts between two stored keys and is not a stored key", () => {
  const model = createModel({ ...kvParams("tiny"), seed: 1 });
  for (const id of [0, 1, 255, 256, 999]) {
    const miss = model.missKey(id);
    assert.equal(miss.length, model.key(id).length + 1);
    assert.ok(compare(model.key(id), miss) < 0, `key(${id}) < miss`);
    assert.ok(compare(miss, model.key(id + 1)) < 0, `miss < key(${id + 1})`);
  }
});

test("verify and verifyAny fail a value whose body differs from its header's", () => {
  const model = createModel({ ...kvParams("tiny"), seed: 1 });
  const good = model.nextValue(3);
  model.verify(3, good);
  assert.equal(model.verifyAny(good), 3);
  const bad = good.slice();
  bad[bad.length - 1]! ^= 1;
  assert.throws(() => model.verify(3, bad), /byte \d+ is/);
  assert.throws(() => model.verifyAny(bad), /byte \d+ is/);
  const middle = good.slice();
  middle[20]! ^= 1;
  assert.throws(() => model.verify(3, middle), /byte 20 is/);
});
