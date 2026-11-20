import assert from "node:assert/strict";
import { test } from "node:test";
import { rng, zipfian } from "../page/model.ts";

test("the hottest ranks hash to the keys YCSB's FNV puts them on", () => {
  // Rank 0 is drawn when u * zetan < 1, rank 1 up to 1 + 0.5^0.99. The keys are fnvhash64(rank) % n, computed apart from this code.
  assert.equal(zipfian(100_000, () => 0)(), 77211);
  assert.equal(zipfian(100_000, () => 0.04)(), 66620);
});

for (const n of [1_000, 100_000, 1_000_000]) {
  test(`the hottest key of ${n} keys takes 1 / 26.47 of the draws, as in YCSB`, () => {
    const draws = 400_000;
    const next = zipfian(n, rng(7));
    const hits = new Map<number, number>();
    for (let i = 0; i < draws; i++) {
      const key = next();
      assert.ok(key >= 0 && key < n);
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
    const [hottest, second] = [...hits.values()].sort((a, b) => b - a);
    assert.ok(Math.abs(hottest! / draws - 1 / 26.46902820178302) < 0.003, `hottest key share ${hottest! / draws}`);
    assert.ok(Math.abs(second! / draws - 1 / (2 ** 0.99 * 26.46902820178302)) < 0.003, `second key share ${second! / draws}`);
  });
}
