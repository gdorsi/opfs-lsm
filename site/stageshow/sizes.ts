/**
 * The design size of each illustration, wide and compact, in CSS pixels. The page reserves a box of this shape
 * before the illustration loads. A stage switches to its compact design in a column narrower than `COMPACT_BELOW`.
 */
export const COMPACT_BELOW = 600;

export const SIZES = {
  bench: { wide: [620, 400], compact: [358, 400] },
  bundle: { wide: [620, 400], compact: [358, 492] },
  stack: { wide: [620, 400], compact: [358, 470] },
} as const satisfies Record<string, { wide: readonly [number, number]; compact: readonly [number, number] }>;

export type SceneName = keyof typeof SIZES;
