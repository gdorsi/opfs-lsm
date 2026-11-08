/**
 * The seeded write workload of the Chrome kill loop, shared by the page
 * (`kill-chrome-main.ts`) and the harness (`scripts/kill-chrome.ts`). A tab
 * runs its attempts one at a time, so the harness can regenerate every
 * attempt a tab may have made from (seed, iteration, tab) alone. Each put
 * writes a value no other attempt writes, so a value read back names the
 * attempt that wrote it.
 */

export type WorkOp =
  | { readonly type: "put"; readonly key: string; readonly value: string }
  | { readonly type: "del"; readonly key: string };

/** Keys the workload writes. Small enough that compaction drops overwrites. */
export const KEY_COUNT = 192;

export function keyName(i: number): string {
  return `k${String(i).padStart(3, "0")}`;
}

/** Every key the workload can write, for point gets after recovery. */
export function allKeys(): string[] {
  return Array.from({ length: KEY_COUNT }, (_, i) => keyName(i));
}

/** mulberry32: small, fast, and the same in Node and Chrome. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One 32-bit seed from several integers. */
export function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  }
  return h >>> 0;
}

/**
 * Attempt `n` (1-based) of `tab` in `iteration`: a put, a delete, or a
 * batch of 2 to 6 ops. Generated in order, so a caller keeps one generator
 * per tab.
 */
export function* attempts(seed: number, iteration: number, tab: number): Generator<WorkOp[]> {
  const rand = prng(mix(seed, iteration, tab));
  const pick = (n: number) => Math.floor(rand() * n);
  for (let n = 1; ; n++) {
    const roll = rand();
    const size = roll < 0.75 ? 1 : roll < 0.85 ? 1 : 2 + pick(5);
    const ops: WorkOp[] = [];
    for (let j = 0; j < size; j++) {
      const key = keyName(pick(KEY_COUNT));
      const del = roll >= 0.75 && roll < 0.85 ? true : size > 1 && rand() < 0.2;
      if (del) {
        ops.push({ type: "del", key });
      } else {
        const pad = 8 + pick(240);
        ops.push({ type: "put", key, value: `${iteration}.${tab}.${n}.${j}|${"x".repeat(pad)}` });
      }
    }
    yield ops;
  }
}
