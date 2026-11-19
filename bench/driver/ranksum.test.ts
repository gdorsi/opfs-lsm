import assert from "node:assert/strict";
import { describe as suite, test } from "node:test";
import { rankSumP, smallestRankSumP } from "./ranksum.ts";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

suite("rankSumP", () => {
  test("5 against 5 with no overlap is 2 in 252", () => {
    near(rankSumP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 2 / 252);
  });

  test("one wild run cannot decide the test, and cannot be ignored", () => {
    near(rankSumP([6.11, 6.17, 6.78, 9.74, 48.23], [10.18, 10.45, 10.85, 11.09, 11.36]), 38 / 252);
  });

  test("one run inside the other side's range, with a tie on one side, is 4 in 252", () => {
    near(rankSumP([42.8, 42.5, 43, 42.8, 47.4], [47.9, 47.6, 48.1, 47.3, 47.8]), 4 / 252);
  });

  test("3 against 3 with no overlap is 0.1, 4 against 4 is 2 in 70", () => {
    near(rankSumP([1, 2, 3], [4, 5, 6]), 0.1);
    near(rankSumP([1, 2, 3, 4], [5, 6, 7, 8]), 2 / 70);
  });

  test("all values equal on both sides is 1", () => {
    assert.equal(rankSumP([7, 7, 7, 7], [7, 7, 7, 7, 7]), 1);
  });

  test("an empty side is 1", () => {
    assert.equal(rankSumP([], [1, 2, 3]), 1);
    assert.equal(rankSumP([1, 2, 3], []), 1);
  });

  test("swapping the sides gives the same p", () => {
    const a = [3.1, 4.1, 5.9, 2.6, 5.3, 5.8];
    const b = [9.7, 9.3, 2.3, 8.4, 6.2];
    near(rankSumP(a, b), rankSumP(b, a));
    near(rankSumP([1, 2, 2, 3], [2, 4, 5]), rankSumP([2, 4, 5], [1, 2, 2, 3]));
  });

  test("21 against 21 returns quickly, and a shifted side is below 0.05 and above 0", () => {
    const a = Array.from({ length: 21 }, (_, i) => 100 + ((i * 7) % 21));
    const b = a.map((x) => x + 8);
    const start = performance.now();
    const p = rankSumP(a, b);
    assert.ok(performance.now() - start < 500);
    assert.ok(p < 0.05 && p > 0, `p is ${p}`);
  });
});

suite("smallestRankSumP", () => {
  test("is 2 over the number of picks", () => {
    near(smallestRankSumP(3, 3), 0.1);
    near(smallestRankSumP(4, 4), 2 / 70);
    near(smallestRankSumP(5, 5), 2 / 252);
    near(smallestRankSumP(2, 7), 2 / 36);
    near(smallestRankSumP(7, 2), 2 / 36);
  });

  test("is 1 when a side has no runs, and never above 1", () => {
    assert.equal(smallestRankSumP(0, 5), 1);
    assert.equal(smallestRankSumP(5, 0), 1);
    assert.equal(smallestRankSumP(1, 1), 1);
  });

  test("equals what disjoint samples of those sizes give", () => {
    for (const [na, nb] of [[4, 6], [5, 5], [3, 8]] as const) {
      near(rankSumP(Array.from({ length: na }, (_, i) => i), Array.from({ length: nb }, (_, i) => 100 + i)), smallestRankSumP(na, nb));
    }
  });
});
