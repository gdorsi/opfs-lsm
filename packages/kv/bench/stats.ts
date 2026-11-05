/** Latency summary shared by the browser pages and the Node benches. */
export type Stats = {
  readonly label: string;
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly p999: number;
  readonly max: number;
  readonly over1ms: number;
};

export function summarize(label: string, samples: ArrayLike<number>): Stats {
  const s = Float64Array.from(samples).sort();
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  let over1ms = 0;
  for (const x of s) if (x > 1) over1ms++;
  return {
    label,
    n: s.length,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    p999: q(0.999),
    max: s[s.length - 1]!,
    over1ms,
  };
}

/** One row in ms, the format `bench:latency` has always printed. */
export function formatMs(row: Stats): string {
  const ms = (x: number) => x.toFixed(3).padStart(8);
  return `${row.label.padEnd(18)} p50 ${ms(row.p50)}  p90 ${ms(row.p90)}  p99 ${ms(row.p99)}  p99.9 ${ms(row.p999)}  max ${ms(row.max)}  >1ms ${row.over1ms}`;
}

/** One row in µs, for operations far under a millisecond. */
export function formatUs(row: Stats): string {
  const us = (x: number) => (x * 1000).toFixed(2).padStart(8);
  return `${row.label.padEnd(22)} p50 ${us(row.p50)} µs  p99 ${us(row.p99)} µs  max ${us(row.max)} µs`;
}

/** Median and range of repeated whole-operation times. */
export function formatRounds(label: string, ms: readonly number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  return `${label.padEnd(22)} median ${s[s.length >> 1]!.toFixed(2)} ms  [${s[0]!.toFixed(2)}..${s[s.length - 1]!.toFixed(2)}]  n=${s.length}`;
}
