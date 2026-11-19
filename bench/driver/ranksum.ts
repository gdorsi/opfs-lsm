/**
 * Pure: the exact two-sided Mann-Whitney (rank-sum) test of two samples.
 *
 * The null hypothesis is that the store makes no difference, so the pooled
 * values are fixed and only their labels are chance: every way to pick which
 * `na` of the `na + nb` values belong to side A is equally likely. The
 * statistic is the sum of side A's ranks in the pooled order, tied values
 * sharing the mean of their ranks. Every rank is doubled so each sum is an
 * integer and needs no float epsilon.
 *
 * `count[k][s]` is the number of ways to pick `k` pooled values whose doubled
 * ranks sum to `s`. One pass over the pooled values fills it, and row `na` is
 * the exact null distribution, ties included.
 */

/** The doubled midrank of every value, in the order given. */
function doubledRanks(pooled: readonly number[]): number[] {
  const order = pooled.map((_, i) => i).sort((i, j) => pooled[i]! - pooled[j]!);
  const ranks = new Array<number>(pooled.length);
  for (let lo = 0; lo < order.length; ) {
    let hi = lo;
    while (hi + 1 < order.length && pooled[order[hi + 1]!] === pooled[order[lo]!]) hi++;
    // Ranks lo + 1 to hi + 1 have the mean (lo + hi + 2) / 2.
    for (let i = lo; i <= hi; i++) ranks[order[i]!] = lo + hi + 2;
    lo = hi + 1;
  }
  return ranks;
}

/**
 * The share of the picks of `a.length` out of both samples whose rank sum is
 * at least as far from the mean rank sum as side `a`'s. 1 when a side is empty.
 */
export function rankSumP(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const n = na + b.length;
  if (na === 0 || b.length === 0) return 1;
  const ranks = doubledRanks([...a, ...b]);
  const top = ranks.reduce((t, r) => t + r, 0);
  const count = Array.from({ length: na + 1 }, () => new Float64Array(top + 1));
  count[0]![0] = 1;
  ranks.forEach((r, i) => {
    for (let k = Math.min(i + 1, na); k >= 1; k--) {
      const into = count[k]!;
      const from = count[k - 1]!;
      for (let s = r; s <= top; s++) into[s]! += from[s - r]!;
    }
  });
  // The mean of the doubled rank sums.
  const mean = na * (n + 1);
  const observed = Math.abs(ranks.slice(0, na).reduce((t, r) => t + r, 0) - mean);
  let extreme = 0;
  let all = 0;
  count[na]!.forEach((c, s) => {
    all += c;
    if (Math.abs(s - mean) >= observed) extreme += c;
  });
  return extreme / all;
}

/** `2 / C(na + nb, na)`: the smallest p two samples of these sizes can give when no two values tie. 1 when a side is empty. */
export function smallestRankSumP(na: number, nb: number): number {
  if (na === 0 || nb === 0) return 1;
  let picks = 1;
  for (let i = 1; i <= Math.min(na, nb); i++) picks = (picks * (na + nb - Math.min(na, nb) + i)) / i;
  return Math.min(1, 2 / picks);
}
