/** The mark docs/benchmarks.md puts after a ratio when the min–max ranges of its two sides overlap. */
export const OVERLAP = "‡";

/** How a ratio such as "8.1×" reads. Within a twentieth of 1 the two are level, and so are two whose runs overlap. */
export function ratioTone(ratio: string): "success" | "neutral" | "warning" {
  if (ratio.includes(OVERLAP)) return "neutral";
  const times = Number.parseFloat(ratio);
  if (times >= 1.05) return "success";
  if (times <= 0.95) return "warning";
  return "neutral";
}
