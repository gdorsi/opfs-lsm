/**
 * Log-linear latency histogram in microseconds: 16 linear sub-buckets per
 * power of two, so any recorded value is within ~6% of its bucket's value.
 * Snapshots merge by adding counts, so percentiles pool across runs.
 * Shared by the page (records) and the driver (merges, reads percentiles).
 */
import type { HistogramSnapshot } from "./types.ts";

const SUB = 16;

function bucketOf(us: number): number {
  if (us < SUB) return Math.max(0, Math.floor(us));
  const exp = Math.floor(Math.log2(us / SUB));
  const base = SUB * 2 ** exp;
  return SUB + exp * SUB + Math.floor(((us - base) / base) * SUB);
}

function valueOf(bucket: number): number {
  if (bucket < SUB) return bucket;
  const exp = Math.floor((bucket - SUB) / SUB);
  const base = SUB * 2 ** exp;
  return base + ((bucket - SUB - exp * SUB + 0.5) / SUB) * base;
}

export class Histogram {
  private readonly counts = new Map<number, number>();
  n = 0;
  sumUs = 0;
  minUs = Infinity;
  maxUs = 0;

  record(us: number): void {
    const b = bucketOf(us);
    this.counts.set(b, (this.counts.get(b) ?? 0) + 1);
    this.n++;
    this.sumUs += us;
    if (us < this.minUs) this.minUs = us;
    if (us > this.maxUs) this.maxUs = us;
  }

  snapshot(): HistogramSnapshot {
    return {
      n: this.n,
      sumUs: this.sumUs,
      minUs: this.n === 0 ? 0 : this.minUs,
      maxUs: this.maxUs,
      buckets: [...this.counts].sort((a, b) => a[0] - b[0]),
    };
  }
}

export function merge(snaps: readonly HistogramSnapshot[]): HistogramSnapshot {
  const counts = new Map<number, number>();
  let n = 0;
  let sumUs = 0;
  let minUs = Infinity;
  let maxUs = 0;
  for (const s of snaps) {
    if (s.n === 0) continue;
    n += s.n;
    sumUs += s.sumUs;
    minUs = Math.min(minUs, s.minUs);
    maxUs = Math.max(maxUs, s.maxUs);
    for (const [b, c] of s.buckets) counts.set(b, (counts.get(b) ?? 0) + c);
  }
  return { n, sumUs, minUs: n === 0 ? 0 : minUs, maxUs, buckets: [...counts].sort((a, b) => a[0] - b[0]) };
}

/** Value at quantile q (0..1); the max for q = 1. */
export function quantile(s: HistogramSnapshot, q: number): number {
  if (s.n === 0) return NaN;
  if (q >= 1) return s.maxUs;
  const target = Math.ceil(q * s.n);
  let seen = 0;
  for (const [b, c] of s.buckets) {
    seen += c;
    if (seen >= target) return Math.min(s.maxUs, Math.max(s.minUs, valueOf(b)));
  }
  return s.maxUs;
}
