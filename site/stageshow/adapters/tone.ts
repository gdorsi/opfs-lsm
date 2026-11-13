/** How a README ratio such as "8.1×" reads. Within a twentieth of 1 the two are level. */
export function ratioTone(ratio: string): "success" | "neutral" | "warning" {
  const times = Number.parseFloat(ratio);
  if (times >= 1.05) return "success";
  if (times <= 0.95) return "warning";
  return "neutral";
}
